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
  lstat,
  realpath,
} from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tmpdir, networkInterfaces } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createServer, createConnection } from "node:net";
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
    "network-host": { type: "string" },
    "legacy-entrypoint": { type: "boolean", default: false },
    "artifact-smoke": { type: "boolean", default: false },
    arch: { type: "string" },
    commit: { type: "string" },
    trace: { type: "string" },
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
const artifactSmoke = values["artifact-smoke"];
assert.ok(
  artifactSmoke || (!values.arch && !values.commit && !values.trace),
  "--arch、--commit 和 --trace 用于 --artifact-smoke",
);
if (artifactSmoke) {
  assert.ok(
    ["amd64", "arm64"].includes(values.arch),
    "产物冒烟必须指定 --arch amd64 或 arm64",
  );
  assert.match(
    values.commit ?? "",
    /^[a-f0-9]{40}$/,
    "产物冒烟必须指定 --commit 完整源码提交",
  );
  assert.match(
    values.version,
    /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/,
    "产物冒烟必须指定发布 tag",
  );
  assert.ok(
    !values["upgrade-dir"] &&
      !values["emulated-arch"] &&
      !values["network-host"] &&
      !values["legacy-entrypoint"] &&
      !values.faults,
    "产物冒烟只在原生架构执行一次签名包安装",
  );
  assert.equal(process.platform, "linux", "产物冒烟需要原生 Linux Docker 主机");
  assert.ok(
    process.env.CLOUDDRIVE_OFFLINE_TRUST_DIR,
    "产物冒烟需要独立的 CLOUDDRIVE_OFFLINE_TRUST_DIR",
  );
}
const smokeTracePath = values.trace ? resolve(values.trace) : undefined;
if (smokeTracePath) await assert.rejects(lstat(smokeTracePath), { code: "ENOENT" });
const source = resolve(values["release-dir"]);
const networkHost = values["network-host"];
assert.ok(
  !networkHost ||
    Object.values(networkInterfaces())
      .flat()
      .some(
        (item) =>
          item &&
          !item.internal &&
          item.family === "IPv4" &&
          item.address === networkHost,
      ),
  "--network-host 必须是当前机器的非回环 IPv4，不能用 localhost 冒充 HTTP 外部入口",
);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dockerPath = spawnSync("sh", ["-c", "command -v docker"], {
  encoding: "utf8",
});
assert.equal(dockerPath.status, 0, "Docker 验收需要可执行的 docker 命令");
const docker = dockerPath.stdout.trim();
const base = await mkdtemp(join(tmpdir(), "clouddrive-release-test-"));
await writeFile(join(base, ".test-owner"), "clouddrive-release-fixture-v1", {
  mode: 0o600,
});
const root = join(base, "instance");
const bootstrap = join(base, "bootstrap.sh");
await cp(join(projectRoot, "install.sh"), bootstrap);
const bin = join(base, "bin");
await mkdir(bin);
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
  origin = `http://${networkHost ?? "127.0.0.1"}:${port}`;
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
    if (!values["legacy-entrypoint"] || networkHost) {
      assert.doesNotMatch(cookie, /^__Host-/);
      assert.doesNotMatch(cookie, /;\s*Secure(?:;|$)/i);
      assert.match(cookie, /;\s*HttpOnly(?:;|$)/i);
    }
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
async function exerciseInstanceLayout(version) {
  const release = join(root, "releases", version);
  const manifest = await readFile(join(release, "manifest.txt"), "utf8");
  if (!manifest.split("\n").includes("INSTANCE_LAYOUT=1")) return;

  const parent = await realpath(base);
  const instance = join(parent, "named-instance");
  const data = join(parent, "named-data");
  const name = `clouddrive-test-${randomBytes(8).toString("hex")}`;
  const volume = `${name}-instance`;
  const owner = sha(Buffer.from([instance, name, data].join("\0")));
  const instancePort = await freePort();
  const dockerOutput = (...args) => run("docker", args).stdout.trim();
  const args = (project, dir, storage, publishedPort) => [
    "--name",
    project,
    "--dir",
    dir,
    "--data-dir",
    storage,
    "--bind",
    "127.0.0.1",
    "--port",
    String(publishedPort),
    "--version",
    version,
    "--release-dir",
    source,
  ];
  const volumeExists = (target) =>
    dockerOutput("volume", "ls", "-q", "--filter", `name=${target}`)
      .split("\n")
      .includes(target);
  const assertAbsent = async (path) => {
    await assert.rejects(lstat(path), { code: "ENOENT" });
  };
  const volumeOwner = () =>
    dockerOutput(
      "volume",
      "inspect",
      "--format",
      '{{index .Labels "io.clouddrive.release.owner"}}',
      volume,
    );
  let stopped = false;
  let completed = false;
  try {
    const installArgs = args(name, instance, data, instancePort);
    const planned = install("plan", "--check", ...installArgs);
    for (const value of [instance, data, name, volume, String(instancePort)]) {
      assert.ok(planned.stdout.includes(value), planned.stdout);
    }
    await assertAbsent(instance);
    await assertAbsent(data);
    assert.equal(volumeExists(volume), false);
    assert.equal(
      dockerOutput(
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${name}`,
      ),
      "",
    );
    assert.equal(
      dockerOutput("network", "ls", "-q", "--filter", `name=^${name}_default$`),
      "",
    );

    install("install", ...installArgs);
    assert.equal(
      (await readFile(join(instance, ".control/project"), "utf8")).trim(),
      name,
    );
    assert.equal(
      (await readFile(join(instance, ".control/data-dir"), "utf8")).trim(),
      data,
    );
    await assertAbsent(join(instance, "data"));

    const [backend, web] = JSON.parse(
      dockerOutput("container", "inspect", `${name}-backend-1`, `${name}-web-1`),
    );
    for (const container of [backend, web]) {
      assert.equal(container.Config.Labels["com.docker.compose.project"], name);
      assert.ok(container.NetworkSettings.Networks[`${name}_default`]);
    }
    const mount = backend.Mounts.find(
      (item) => item.Destination === "/app/.data",
    );
    assert.equal(mount?.Type, "bind");
    assert.equal(mount.Source, data);
    assert.equal(mount.RW, true);
    assert.equal(volumeOwner(), owner);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${instancePort}/login`, {
          signal: AbortSignal.timeout(15000),
        })
      ).status,
      200,
    );

    const conflictRoot = join(parent, "layout-conflict");
    const unusedData = join(parent, "layout-unused");
    const unusedPort = await freePort();
    const otherName = `${name}-two`;
    const rejectConflict = async (conflictingArgs, details) => {
      for (const command of [["plan", "--check"], ["install"]]) {
        const failed = run(
          "bash",
          [bootstrap, ...command, ...conflictingArgs],
          { failure: true },
        );
        for (const value of details)
          assert.ok(failed.stderr.includes(value), failed.stderr);
        assert.doesNotMatch(failed.stderr, /下载 checksums\.txt/);
        await assertAbsent(conflictRoot);
        await assertAbsent(unusedData);
        assert.equal(volumeExists(`${otherName}-instance`), false);
      }
    };
    await rejectConflict(args(name, conflictRoot, unusedData, unusedPort), [
      name,
      "--name",
    ]);
    await rejectConflict(args(otherName, conflictRoot, data, unusedPort), [
      data,
      "--data-dir",
    ]);
    await rejectConflict(
      args(otherName, conflictRoot, unusedData, instancePort),
      [`127.0.0.1:${instancePort}`, "--port"],
    );

    compose(instance, version, "down", "--remove-orphans");
    stopped = true;
    await rejectConflict(args(name, conflictRoot, unusedData, unusedPort), [
      volume,
      "--name",
    ]);
    console.log(
      "真实 Docker 自定义实例验证通过：外部数据挂载、项目命名、同名与路径及端口预检。",
    );
    completed = true;
  } finally {
    try {
      if (volumeExists(volume)) {
        assert.equal(
          volumeOwner(),
          owner,
          "拒绝清理不属于当前测试的实例归属卷",
        );
        const config = join(instance, "releases", version, "compose.yaml");
        const installed = await lstat(config).then(
          () => true,
          (error) => {
            if (error.code !== "ENOENT") throw error;
            return false;
          },
        );
        if (!stopped && installed)
          compose(instance, version, "down", "--remove-orphans");
        dockerOutput("volume", "rm", volume);

        const webImage = (await readFile(join(release, "images.env"), "utf8"))
          .split("\n")
          .find((line) => line.startsWith("WEB_IMAGE="))
          .slice(10);
        run("docker", [
          "run",
          "--rm",
          "--pull",
          "never",
          "--user",
          "0:0",
          "--mount",
          `type=bind,source=${parent},target=/fixture`,
          webImage,
          "node",
          "-e",
          'require("node:fs").rmSync("/fixture/named-data",{recursive:true,force:true})',
        ]);
        await assertAbsent(data);
      }
    } catch (error) {
      if (completed) throw error;
      console.error("自定义实例验收清理失败：", error);
    }
  }
}
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
async function exerciseArtifactSmoke(trace) {
  const platform = {
    x86_64: "amd64", aarch64: "arm64", amd64: "amd64", arm64: "arm64",
  };
  const hostArch = { x64: "amd64", arm64: "arm64" }[process.arch];
  const [os, daemonArch] = run("docker", [
    "info", "--format", "{{.OSType}}|{{.Architecture}}",
  ]).stdout.trim().split("|");
  trace.platform = { os, hostArch, daemonArch };
  assert.equal(hostArch, values.arch, "Node 运行平台与目标原生架构不符");
  assert.equal(os, "linux", "Docker daemon 必须运行 Linux 容器");
  assert.equal(platform[daemonArch], values.arch, "Docker daemon 与目标原生架构不符");

  trace.phase = "install";
  install(
    "install", "--dir", root, "--bind", "127.0.0.1", "--port", String(port),
    "--version", active, "--release-dir", source,
  );
  assert.equal((await readFile(join(root, ".control/current"), "utf8")).trim(), active);

  trace.phase = "health";
  const probe = async (path) => {
    const response = await fetch(origin + path, {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    trace.http[path] = response.status;
    assert.equal(response.status, 200, `${path} 未就绪`);
    return response;
  };
  const page = await probe("/login");
  assert.match(page.headers.get("Content-Type") ?? "", /^text\/html(?:;|$)/i);
  assert.match(await page.text(), /<!doctype html>/i);
  assert.equal((await (await probe("/management/readyz")).json()).status, "pass");
  const build = await (await probe("/management/build")).json();
  trace.runningBuild = { version: build.version, commit: build.commit, dirty: build.dirty };
  assert.equal(build.version, active);
  assert.equal(build.commit, values.commit);
  assert.equal(build.dirty, false);

  trace.phase = "image-identity";
  for (const service of ["backend", "web"]) {
    const container = compose(root, active, "ps", "--quiet", service).stdout.trim();
    assert.match(container, /^[a-f0-9]{12,64}$/, `${service} 必须有且只有一个运行容器`);
    const image = run("docker", ["container", "inspect", "--format", "{{.Image}}", container]).stdout.trim();
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const format = [
      "{{.Os}}",
      "{{.Architecture}}",
      '{{index .Config.Labels "org.opencontainers.image.version"}}',
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      '{{index .Config.Labels "org.opencontainers.image.licenses"}}',
    ].join("|");
    const identity = run("docker", ["image", "inspect", "--format", format, image]).stdout.trim();
    trace.images[service] = { id: image, identity };
    assert.equal(identity, `linux|${values.arch}|${active}|${values.commit}|Apache-2.0`);
  }
  trace.phase = "ready";
}

async function exerciseFullRelease() {
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
    ...(values["legacy-entrypoint"]
      ? ["--bind", "0.0.0.0", "--public-url", origin, "--allow-http"]
      : []),
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
  await exerciseInstanceLayout(active);
  if (values["legacy-entrypoint"]) {
    // 后续成功升级真正由旧包自带安装器执行，验证已发布管理入口的兼容性。
    await cp(join(root, "install.sh"), bootstrap);
  }
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
  if (!values["legacy-entrypoint"]) {
    const share = await request("/native/files/shares", "POST", {
      rootId: entry.id,
      title: "release-share",
    });
    const shareURL = origin + "/api/v1/file-shares/" + share.token;
    const metadata = await fetch(shareURL, {
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).root.id, entry.id);
    const grant = await fetch(shareURL + "/content/" + entry.id + "/download", {
      method: "POST",
      headers: { Origin: origin },
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(grant.status, 200);
    const ticket = (await grant.json()).ticket;
    const sharedFile = await fetch(
      origin + "/api/v1/file-downloads/" + ticket,
      { signal: AbortSignal.timeout(30000) },
    );
    assert.equal(sharedFile.status, 200);
    assert.equal(
      sha(Buffer.from(await sharedFile.arrayBuffer())),
      sha(content),
    );
    const connection = await request("/native/files/connections", "POST", {
      rootId: folder.id,
      name: "release-dav",
      readOnly: false,
      blockSystemFiles: false,
    });
    assert.equal(
      connection.endpointOrigin,
      origin,
      "连接地址必须使用当前 Web 入口，而不是容器地址",
    );
    const endpoint = new URL(connection.endpointPath, connection.endpointOrigin)
      .href;
    const davHeaders = {
      Authorization:
        "Basic " +
        Buffer.from(connection.id + ":" + connection.password).toString(
          "base64",
        ),
    };
    let dav = await fetch(endpoint + "source.txt", {
      method: "PUT",
      headers: davHeaders,
      body: "DAV persisted bytes",
    });
    assert.equal(dav.status, 201);
    await dav.arrayBuffer();
    dav = await fetch(endpoint + "source.txt", {
      method: "MOVE",
      headers: { ...davHeaders, Destination: endpoint + "moved.txt" },
    });
    assert.equal(dav.status, 201);
    await dav.arrayBuffer();
    dav = await fetch(endpoint + "moved.txt", { headers: davHeaders });
    assert.equal(dav.status, 200);
    assert.equal(await dav.text(), "DAV persisted bytes");
    if (!values["legacy-entrypoint"]) {
      const bytes = Buffer.alloc(33 * 1024 * 1024, 79);
      for (const fixed of [true, false]) {
        const address = endpoint + (fixed ? "fixed.bin" : "chunked.bin");
        const upload = await fetch(address, {
          method: "PUT",
          headers: davHeaders,
          body: fixed ? bytes : (async function* () {
            const block = 1024 * 1024;
            for (let offset = 0; offset < bytes.length; offset += block)
              yield bytes.subarray(offset, offset + block);
          })(),
          duplex: "half",
          signal: AbortSignal.timeout(60_000),
        });
        assert.equal(upload.status, 201);
        await upload.arrayBuffer();
        const download = await fetch(address, {
          headers: davHeaders,
          signal: AbortSignal.timeout(30_000),
        });
        assert.equal(download.status, 200);
        assert.equal(sha(Buffer.from(await download.arrayBuffer())), sha(bytes));
      }
    }
    const forged = await fetch(origin + "/api/console/v1/auth/logout", {
      method: "POST",
      headers: {
        Origin: "http://evil.example",
        "X-Forwarded-Host": "evil.example",
        "X-CloudDrive-Web-Origin": origin,
        "X-CSRF-Token": csrf,
        Cookie: [...cookieJar].map(([k, v]) => k + "=" + v).join("; "),
      },
    });
    assert.equal(forged.status, 403);
    await forged.arrayBuffer();
    const badCSRF = await fetch(origin + "/api/console/v1/auth/logout", {
      method: "POST",
      headers: {
        Origin: origin,
        "X-CSRF-Token": "wrong",
        Cookie: [...cookieJar].map(([k, v]) => k + "=" + v).join("; "),
      },
    });
    assert.equal(badCSRF.status, 403);
    await badCSRF.arrayBuffer();
    // 改变入口端口，不改安装配置；验证普通 TCP 转发下的同源会话与链接展示。
    const sockets = new Set();
    const relay = createServer((client) => {
      const upstream = createConnection({ host: "127.0.0.1", port });
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise((done, fail) =>
      relay.once("error", fail).listen(0, "0.0.0.0", done),
    );
    try {
      const forwardedOrigin = `http://${networkHost ?? "127.0.0.1"}:${relay.address().port}`;
      const headers = {
        Origin: forwardedOrigin,
        Cookie: [...cookieJar].map(([k, v]) => k + "=" + v).join("; "),
        Connection: "close",
      };
      const session = await fetch(
        forwardedOrigin + "/api/console/v1/auth/session",
        { headers, signal: AbortSignal.timeout(30000) },
      );
      assert.equal(session.status, 200);
      assert.equal((await session.json()).user.id, id);
      const listing = await fetch(
        forwardedOrigin + "/api/console/v1/native/files/connections",
        { headers, signal: AbortSignal.timeout(30000) },
      );
      assert.equal(listing.status, 200);
      assert.equal(
        (await listing.json()).items.find((item) => item.id === connection.id)
          .endpointOrigin,
        forwardedOrigin,
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => relay.close(done));
    }
  }
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
  // API/management 不映射宿主机；只有 Web 对外发布。
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
    ["0.0.0.0"],
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
          .replace(/^WEB_PORT=.*$/m, "WEB_PORT=" + clonePort)
          // 故障副本只使用自己的回环入口，不继承原实例的公网 Origin 或监听地址。
          .replace(/^WEB_BIND=.*$/m, "WEB_BIND=127.0.0.1")
          .replace(
            /^PUBLIC_ORIGIN=.*$/m,
            `PUBLIC_ORIGIN=http://127.0.0.1:${clonePort}`,
          )
          .replace(
            /^ALLOWED_ORIGINS=.*$/m,
            `ALLOWED_ORIGINS='${JSON.stringify([`http://127.0.0.1:${clonePort}`, `http://localhost:${clonePort}`])}'`,
          ),
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
}

async function cleanupFixture() {
  for (const item of additionalInstances) {
    try {
      compose(item.root, item.version, "down", "--remove-orphans");
    } catch {
      /* 保留独立故障现场。 */
    }
  }
  if (!values.keep || !ok) {
    try {
      if (!artifactSmoke || (await validateSmokeProject())) {
        compose(root, active, "down", "--remove-orphans");
      }
    } catch (error) {
      if (artifactSmoke) throw error;
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

async function validateSmokeProject() {
  assert.equal(
    await readFile(join(base, ".test-owner"), "utf8"),
    "clouddrive-release-fixture-v1",
  );
  const project = await readFile(join(root, ".control/project"), "utf8").catch((error) => {
    if (error.code !== "ENOENT" || ok) throw error;
    return "";
  });
  if (!project) return false;
  const expected = "clouddrive-" + sha(await realpath(root)).slice(0, 12);
  assert.equal(project.trim(), expected, "拒绝清理不属于本次验收的 Compose 项目");
  return true;
}

async function runArtifactSmoke() {
  const started = Date.now();
  const trace = {
    schema: "clouddrive-docker-artifact-smoke-v1",
    version: active,
    expectedArch: values.arch,
    expectedCommit: values.commit,
    phase: "platform",
    http: {},
    images: {},
  };
  const failures = [];
  try {
    await exerciseArtifactSmoke(trace);
    ok = true;
  } catch (error) {
    failures.push(error);
  }
  try {
    await cleanupFixture();
    trace.fixture = ok && !values.keep ? "removed" : base;
  } catch (error) {
    failures.push(error);
    trace.fixture = base;
    trace.cleanup = "failed";
  }
  trace.result = failures.length ? "failed" : "passed";
  trace.elapsedMs = Date.now() - started;
  if (smokeTracePath) {
    try {
      await mkdir(dirname(smokeTracePath), { recursive: true });
      await writeFile(smokeTracePath, JSON.stringify(trace, null, 2) + "\n", {
        flag: "wx", mode: 0o600,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Docker 签名产物冒烟失败");
  console.log(`Docker 签名产物冒烟通过：${active} linux/${values.arch} ${values.commit}。`);
  if (values.keep) console.log("验收实例保留：" + base);
}

if (artifactSmoke) await runArtifactSmoke();
else {
  try {
    await exerciseFullRelease();
  } finally {
    await cleanupFixture();
  }
}
