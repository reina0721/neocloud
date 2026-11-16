#!/usr/bin/env node
// 只操作本脚本创建的隔离目录与 Compose project；不会接管预览/用户实例。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  chmod,
  rm,
  readdir,
} from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createServer } from "node:net";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
const { values } = parseArgs({
  options: {
    "release-dir": { type: "string" },
    version: { type: "string" },
    "upgrade-dir": { type: "string" },
    "upgrade-version": { type: "string" },
    "emulated-arch": { type: "string" },
    keep: { type: "boolean", default: false },
    faults: { type: "boolean", default: false },
  },
});
assert.ok(
  values["release-dir"] && values.version,
  "--release-dir 与 --version 必填",
);
assert.equal(
  Boolean(values["upgrade-dir"]),
  Boolean(values["upgrade-version"]),
  "升级目录和版本必须一起提供",
);
const source = resolve(values["release-dir"]);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = await mkdtemp(join(tmpdir(), "clouddrive-release-test-"));
await writeFile(join(base, ".test-owner"), "clouddrive-release-fixture-v1", {
  mode: 0o600,
});
const root = join(base, "instance");
const bootstrap = join(base, "bootstrap.sh");
await cp(join(projectRoot, "install.sh"), bootstrap);
const bin = join(base, "bin");
await mkdir(bin);
const docker = spawnSync("sh", ["-c", "command -v docker"], {
  encoding: "utf8",
}).stdout.trim();
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const dockerArgs =
  process.env.CLOUDDRIVE_DOCKER_SUDO === "1"
    ? ["sudo", "-n", docker]
    : [docker];
const architectureOverride = values["emulated-arch"];
assert.ok(!architectureOverride || architectureOverride === "arm64");
await writeFile(
  join(bin, "docker"),
  `#!/usr/bin/env bash
set -euo pipefail
${architectureOverride ? 'if [[ $* == "info --format {{.Architecture}}" ]]; then echo arm64; exit 0; fi' : ""}
exec ${dockerArgs.map(quote).join(" ")} "$@"
`,
  { mode: 0o700 },
);
const env = { ...process.env, PATH: bin + ":" + process.env.PATH };
function run(command, args, { failure = false, input } = {}) {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    input,
    timeout: 300000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (failure) assert.notEqual(result.status, 0, "预期命令失败");
  else
    assert.equal(
      result.status,
      0,
      `${command} 失败：${result.error?.message ?? result.stderr}`,
    );
  return result;
}
const install = (...args) => run("bash", [bootstrap, ...args]);
const freePort = async () => {
  const server = createServer();
  await new Promise((ok, fail) =>
    server.once("error", fail).listen(0, "127.0.0.1", ok),
  );
  const port = server.address().port;
  await new Promise((ok) => server.close(ok));
  return port;
};
function compose(target, version, ...args) {
  const project = run("cat", [join(target, ".control/project")]).stdout.trim();
  return run("docker", [
    "compose",
    "--project-directory",
    target,
    "--env-file",
    join(target, "runtime.env"),
    "--env-file",
    join(target, "releases", version, "images.env"),
    "--project-name",
    project,
    "--file",
    join(target, "releases", version, "compose.yaml"),
    ...args,
  ]);
}
const additionalInstances = [];
let active = values.version;
let ok = false;
const cookieJar = new Map();
let csrf = "";
const port = await freePort(),
  origin = `http://127.0.0.1:${port}`;
async function request(path, method = "GET", body) {
  const response = await fetch(origin + "/api/console/v1" + path, {
    method,
    headers: {
      Connection: "close",
      Origin: origin,
      Cookie: [...cookieJar].map(([k, v]) => k + "=" + v).join("; "),
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    const at = pair.indexOf("=");
    cookieJar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  assert.ok(response.ok, `${method} ${path} HTTP ${response.status}`);
  if (path.endsWith("/content"))
    return Buffer.from(await response.arrayBuffer());
  return response.json();
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
async function storageSnapshot() {
  const webImage = (
    await readFile(join(root, "releases", active, "images.env"), "utf8")
  )
    .split("\n")
    .find((x) => x.startsWith("WEB_IMAGE="))
    .slice(10);
  const result = run("docker", [
    "run",
    "--rm",
    "--pull",
    "never",
    "--user",
    "0:0",
    "--mount",
    `type=bind,source=${root}/data,target=/data,readonly`,
    webImage,
    "node",
    "--disable-warning=ExperimentalWarning",
    "-e",
    `
    const f=require('node:fs'),c=require('node:crypto');
    for(const suffix of ['', '-wal', '-shm'])if(f.existsSync('/data/app.db'+suffix))f.copyFileSync('/data/app.db'+suffix,'/tmp/probe.db'+suffix);
    const d=new(require('node:sqlite').DatabaseSync)('/tmp/probe.db');
    const bindings=d.prepare('SELECT id, identity FROM files_storage ORDER BY id').all(); d.close();
    const hash=c.createHash('sha256');
    function walk(path,relative=''){for(const n of f.readdirSync(path).sort()){const p=path+'/'+n,r=relative+'/'+n,s=f.lstatSync(p);if(s.isDirectory())walk(p,r);else if(s.isFile()){hash.update(r+'\\0');hash.update(f.readFileSync(p))}else throw Error('Unexpected storage entry')}}
    walk('/data/storage'); console.log(JSON.stringify({bindings,blobs:hash.digest('hex')}));
  `,
  ]);
  return JSON.parse(result.stdout);
}
try {
  install(
    "install",
    "--dir",
    root,
    "--port",
    String(port),
    "--version",
    active,
    "--release-dir",
    source,
  );
  install(
    "install",
    "--dir",
    root,
    "--version",
    active,
    "--release-dir",
    source,
  );
  const setupToken = (
    await readFile(join(root, ".control/setup-token"), "utf8")
  ).trim();
  const account = {
    email: "release-owner@clouddrive.test",
    password: randomBytes(24).toString("base64url"),
  };
  csrf = (await request("/auth/csrf")).token;
  await request("/auth/setup", "POST", {
    ...account,
    name: "发布验收管理员",
    setupToken,
  });
  const session = await request("/auth/login", "POST", account);
  csrf = (await request("/auth/csrf")).token;
  const id = session.user.id;
  const originalRoles = (await request("/users/" + id)).user.roleIds;
  assert.ok(Array.isArray(originalRoles) && originalRoles.length > 0);
  const folder = await request("/native/files/folders", "POST", {
    parentId: "",
    name: "release-retention-" + randomUUID(),
  });
  const text = "Release 安装与升级保留数据\n" + randomUUID();
  const entry = await request("/native/files/text", "POST", {
    parentId: folder.id,
    name: "persistent.txt",
    text,
    key: randomUUID(),
  });
  const content = await request("/native/files/" + entry.id + "/content");
  assert.equal(sha(content), sha(Buffer.from(text)));
  const originalEnvironment = await readFile(join(root, "runtime.env"));
  const originalProject = await readFile(join(root, ".control/project"));
  const apiContainer = compose(
    root,
    active,
    "ps",
    "--quiet",
    "backend",
  ).stdout.trim();
  const originalStorage = run("docker", [
    "exec",
    apiContainer,
    "/app/clouddrive",
    "db",
    "migrate",
    "status",
  ]).stdout;
  assert.equal(JSON.parse(originalStorage).compatible, true);
  // API/management 不映射宿主机；只有 loopback Web 可访问。
  const published = JSON.parse(
    run("docker", [
      "inspect",
      "--format",
      "{{json .HostConfig.PortBindings}}",
      apiContainer,
    ]).stdout,
  );
  assert.ok(!published || Object.keys(published).length === 0);
  const webContainer = compose(
    root,
    active,
    "ps",
    "--quiet",
    "web",
  ).stdout.trim();
  const bindings = JSON.parse(
    run("docker", [
      "inspect",
      "--format",
      "{{json .HostConfig.PortBindings}}",
      webContainer,
    ]).stdout,
  );
  assert.deepEqual(
    bindings["4173/tcp"].map((x) => x.HostIp),
    ["127.0.0.1"],
  );
  install("stop", "--dir", root);
  const originalSnapshot = await storageSnapshot();
  install("start", "--dir", root);
  assert.equal((await request("/auth/session")).user.id, id);
  assert.equal(
    sha(await request("/native/files/" + entry.id + "/content")),
    sha(content),
  );
  install("backup", "--dir", root);
  assert.ok((await readdir(join(root, "backups"))).length > 0);
  // 损坏安装包必须在停止旧服务前失败。
  const corrupted = join(base, "corrupted");
  await cp(source, corrupted, { recursive: true });
  const archive = (await readdir(corrupted)).find((n) =>
    n.endsWith("_docker.tar.gz"),
  );
  await writeFile(join(corrupted, archive), "corrupted");
  const currentBefore = await readFile(join(root, ".control/current"));
  if (values["upgrade-version"]) {
    if (values.faults) {
      // 只在本脚本拥有的数据库副本制造 dirty migration，不触碰原实例。
      const clone = join(base, "migration-fault");
      await mkdir(join(clone, ".control"), { recursive: true });
      await mkdir(join(clone, "releases"), { recursive: true });
      await mkdir(join(clone, "backups"));
      await mkdir(join(clone, "data"));
      install("stop", "--dir", root);
      const oldWeb = (
        await readFile(join(root, "releases", active, "images.env"), "utf8")
      )
        .split("\n")
        .find((x) => x.startsWith("WEB_IMAGE="))
        .slice(10);
      run("docker", [
        "run",
        "--rm",
        "--pull",
        "never",
        "--user",
        "0:0",
        "--mount",
        `type=bind,source=${root}/data,target=/source,readonly`,
        "--mount",
        `type=bind,source=${clone}/data,target=/target`,
        oldWeb,
        "sh",
        "-ec",
        "cp -a /source/. /target/; chmod 700 /target; chown 65532:65532 /target",
      ]);
      await cp(
        join(root, "releases", active),
        join(clone, "releases", active),
        { recursive: true },
      );
      const clonePort = await freePort();
      await writeFile(
        join(clone, "runtime.env"),
        originalEnvironment
          .toString()
          .replace(/^WEB_PORT=.*$/m, "WEB_PORT=" + clonePort),
        { mode: 0o600 },
      );
      await writeFile(
        join(clone, ".control/project"),
        "clouddrive-" + sha(Buffer.from(clone)).slice(0, 12) + "\n",
      );
      await writeFile(join(clone, ".control/current"), active + "\n");
      additionalInstances.push({ root: clone, version: active });
      run("docker", [
        "run",
        "--rm",
        "--pull",
        "never",
        "--user",
        "0:0",
        "--mount",
        `type=bind,source=${clone}/data,target=/data`,
        oldWeb,
        "node",
        "--disable-warning=ExperimentalWarning",
        "-e",
        'const d=new(require("node:sqlite").DatabaseSync)("/data/app.db");d.prepare("UPDATE iam_schema_migrations SET dirty=1").run();d.close()',
      ]);
      install("start", "--dir", root);
      const failed = run(
        "bash",
        [
          bootstrap,
          "upgrade",
          "--dir",
          clone,
          "--version",
          values["upgrade-version"],
          "--release-dir",
          resolve(values["upgrade-dir"]),
        ],
        { failure: true },
      );
      assert.match(failed.stderr, /未自动回退数据库/);
      assert.match(failed.stderr, /dirty|脏|migration/i);
      assert.equal(
        (await readFile(join(clone, ".control/current"), "utf8")).trim(),
        active,
      );
      assert.ok((await readdir(join(clone, "backups"))).length > 0);
      // 明确恢复测试夹具：先保存 dirty 现场，再从已验证的升级前备份恢复副本。
      const cleanBackup = (await readdir(join(root, "backups"))).sort()[0];
      run("docker", [
        "run",
        "--rm",
        "--pull",
        "never",
        "--user",
        "0:0",
        "--mount",
        `type=bind,source=${clone}/data,target=/data`,
        "--mount",
        `type=bind,source=${root}/backups/${cleanBackup},target=/backup,readonly`,
        oldWeb,
        "sh",
        "-ec",
        "cd /data; tar -cf dirty-state.tar app.db; rm -f app.db app.db-wal app.db-shm; tar -xf /backup/database.tar",
      ]);
      install("start", "--dir", clone);
      const restored = await fetch(
        `http://127.0.0.1:${clonePort}/api/console/v1/native/files/${entry.id}/content`,
        {
          headers: {
            Connection: "close",
            Origin: `http://127.0.0.1:${clonePort}`,
            Cookie: [...cookieJar].map(([k, v]) => k + "=" + v).join("; "),
          },
          signal: AbortSignal.timeout(30000),
        },
      );
      assert.equal(restored.status, 200);
      assert.equal(
        sha(Buffer.from(await restored.arrayBuffer())),
        sha(content),
      );
      compose(clone, active, "down", "--remove-orphans");
      console.log(
        "真实 dirty migration 拒绝、不自动降级及备份恢复副本验证通过。",
      );
    }
    // 使用目标版本的完整配套产物进行真实升级。
    const brokenSource = join(base, "corrupt-upgrade");
    await cp(resolve(values["upgrade-dir"]), brokenSource, { recursive: true });
    const packageName = (await readdir(brokenSource)).find((n) =>
      n.endsWith("_docker.tar.gz"),
    );
    await writeFile(join(brokenSource, packageName), "corrupted");
    run(
      "bash",
      [
        join(projectRoot, "install.sh"),
        "upgrade",
        "--dir",
        root,
        "--version",
        values["upgrade-version"],
        "--release-dir",
        brokenSource,
      ],
      { failure: true },
    );
    assert.deepEqual(
      await readFile(join(root, ".control/current")),
      currentBefore,
    );
    assert.equal((await request("/auth/session")).user.id, id);
    // 真实目录权限造成备份创建失败；不能执行迁移，旧服务必须恢复。
    await chmod(join(root, "backups"), 0o500);
    try {
      run(
        "bash",
        [
          join(projectRoot, "install.sh"),
          "upgrade",
          "--dir",
          root,
          "--version",
          values["upgrade-version"],
          "--release-dir",
          resolve(values["upgrade-dir"]),
        ],
        { failure: true },
      );
    } finally {
      await chmod(join(root, "backups"), 0o700);
    }
    assert.deepEqual(
      await readFile(join(root, ".control/current")),
      currentBefore,
    );
    assert.equal((await request("/auth/session")).user.id, id);
    install(
      "upgrade",
      "--dir",
      root,
      "--version",
      values["upgrade-version"],
      "--release-dir",
      resolve(values["upgrade-dir"]),
    );
    active = values["upgrade-version"];
    install(
      "upgrade",
      "--dir",
      root,
      "--version",
      active,
      "--release-dir",
      resolve(values["upgrade-dir"]),
    );
    assert.equal(
      (await readFile(join(root, ".control/current"), "utf8")).trim(),
      active,
    );
  }
  assert.deepEqual(
    await readFile(join(root, "runtime.env")),
    originalEnvironment,
  );
  assert.deepEqual(
    await readFile(join(root, ".control/project")),
    originalProject,
  );
  assert.equal((await request("/auth/session")).user.id, id);
  assert.equal(
    sha(await request("/native/files/" + entry.id + "/content")),
    sha(content),
  );
  assert.deepEqual((await request("/users/" + id)).user.roleIds, originalRoles);
  install("stop", "--dir", root);
  assert.deepEqual(await storageSnapshot(), originalSnapshot);
  install("start", "--dir", root);
  const occupied = createServer();
  const occupiedPort = await new Promise((done, fail) =>
    occupied
      .once("error", fail)
      .listen(0, "127.0.0.1", () => done(occupied.address().port)),
  );
  try {
    run(
      "bash",
      [
        join(projectRoot, "install.sh"),
        "install",
        "--dir",
        join(base, "occupied"),
        "--port",
        String(occupiedPort),
        "--version",
        values.version,
        "--release-dir",
        source,
      ],
      { failure: true },
    );
  } finally {
    await new Promise((done) => occupied.close(done));
  }
  await writeFile(
    join(base, "access.json"),
    JSON.stringify(
      {
        url: origin + "/home",
        username: account.email,
        password: account.password,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `真实 Docker 验收通过：${architectureOverride ? "QEMU " + architectureOverride + "（本机 daemon 架构选择夹具）" : "原生 " + run("docker", ["info", "--format", "{{.Architecture}}"]).stdout.trim()}，版本 ${active}，初始化、文件、会话、重启、备份${values["upgrade-dir"] ? "、失败恢复、升级" : ""}。`,
  );
  if (values.keep) console.log("验收实例保留：" + base);
  ok = true;
} finally {
  for (const item of additionalInstances) {
    try {
      compose(item.root, item.version, "down", "--remove-orphans");
    } catch {
      /* 保留独立故障现场。 */
    }
  }
  if (!values.keep || !ok) {
    try {
      compose(root, active, "down", "--remove-orphans");
    } catch {
      /* 失败现场仍保留。 */
    }
  }
  if (ok && !values.keep) {
    assert.equal(
      await readFile(join(base, ".test-owner"), "utf8"),
      "clouddrive-release-fixture-v1",
    );
    const webImage = (
      await readFile(join(root, "releases", active, "images.env"), "utf8")
    )
      .split("\n")
      .find((x) => x.startsWith("WEB_IMAGE="))
      .slice(10);
    run("docker", [
      "run",
      "--rm",
      "--pull",
      "never",
      "--user",
      "0:0",
      "--mount",
      `type=bind,source=${base},target=/fixture`,
      webImage,
      "node",
      "-e",
      'const f=require("node:fs");for(const n of f.readdirSync("/fixture"))f.rmSync("/fixture/"+n,{recursive:true,force:true})',
    ]);
    await rm(base, { recursive: true, force: true });
  } else if (!ok) console.error("已保留失败验收现场：" + base);
}
