import { test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readdir,
  writeFile,
  readFile,
  chmod,
  realpath,
  rm,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const installer = resolve("install.sh");
const commit = "a".repeat(40);
const apiConfig =
    '{"os":"linux","architecture":"amd64","config":{"Image":"api"}}',
  webConfig = '{"os":"linux","architecture":"amd64","config":{"Image":"web"}}';
const apiID = "sha256:" + createHash("sha256").update(apiConfig).digest("hex"),
  webID = "sha256:" + createHash("sha256").update(webConfig).digest("hex");
const projectFor = (path) =>
  `neocloud-${createHash("sha256").update(path).digest("hex").slice(0, 12)}`;
const offlineBundle = '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}\n';
const checksum = (name, body) =>
  `${createHash("sha256").update(body).digest("hex")}  ${name}\n`;
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "neocloud-installer-unit-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bin = join(base, "bin"),
    log = join(base, "docker.log");
  await mkdir(bin);
  const trust = join(base, "trust");
  await mkdir(trust);
  await writeFile(join(trust, "trusted_root.json"), "{}\n");
  await writeFile(
    join(bin, "cosign"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ $1 == verify-blob && $* == *'--new-bundle-format'* ]]
if [[ " $* " == *' --offline '* ]]; then
  [[ $* == *'--offline --new-bundle-format --trusted-root '* ]]
fi
[[ -f \${!#} && \${FAKE_SIGNATURE_FAILURE:-0} != 1 ]]
`,
    { mode: 0o700 },
  );
  await mkdir(join(base, "volumes"));
  await writeFile(join(base, "app.db"), "fixture-database");
  await mkdir(join(base, "exported/blobs/sha256"), { recursive: true });
  await writeFile(
    join(base, "exported/blobs/sha256", apiID.slice(7)),
    apiConfig,
  );
  await writeFile(
    join(base, "exported/blobs/sha256", webID.slice(7)),
    webConfig,
  );
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_LOG"
mounted_source() {
  local option source
  for option; do
    case $option in
      type=bind,source=*,target=*) source=\${option#type=bind,source=}; printf '%s\\n' "\${source%,target=*}"; return ;;
    esac
  done
  return 1
}
case "$1" in
 info) case "\${*:2}" in *Architecture*) echo amd64 ;; *OSType*) echo linux ;; *) true ;; esac ;;
 context) echo unix:///fake/docker.sock ;;
 ps)
   if [[ $* == *--quiet* && -n \${FAKE_MOUNT_SOURCE:-} ]]; then echo foreign-mount; fi
   if [[ $* == *--quiet* && -n \${FAKE_CONTAINER_PORT:-} ]]; then echo foreign-port; fi
   for option; do
     case "\${FAKE_NAME_CONFLICT:-}:$option" in
       project-container:label=com.docker.compose.project=*) echo "\${option#label=com.docker.compose.project=}-other-1" ;;
       exact-container:name=*'-web-1$') name=\${option#name=^/}; echo "\${name%\$}" ;;
     esac
   done ;;
 inspect|container)
   case "$*" in
     *.Mounts*) [[ -z \${FAKE_MOUNT_SOURCE:-} ]] || printf '/foreign-mount\\t%s\\ttrue\\n' "$FAKE_MOUNT_SOURCE" ;;
     *.NetworkSettings.Ports*) [[ -z \${FAKE_CONTAINER_PORT:-} ]] || printf '/foreign-web\\t0.0.0.0\\t%s\\t4173/tcp\\n' "$FAKE_CONTAINER_PORT" ;;
   esac ;;
 volume)
   case $2 in
     ls)
       for marker in "$FAKE_BASE/volumes/"*; do
         [[ ! -f $marker ]] || basename -- "$marker"
       done
       if [[ -n \${FAKE_FOREIGN_VOLUME:-} ]]; then echo "$FAKE_FOREIGN_VOLUME"; fi ;;
     inspect)
       marker=\${!#}
       if [[ $marker == "\${FAKE_FOREIGN_VOLUME:-}" ]]; then echo foreign-owner; else cat "$FAKE_BASE/volumes/$marker"; fi ;;
     create)
       marker=\${!#}
       label=
       for option; do
         case $option in io.neocloud.release.owner=*) label=\${option#*=} ;; esac
       done
       [[ -n $label ]]
       if [[ ! -e $FAKE_BASE/volumes/$marker ]]; then
         (set -o noclobber; printf '%s\\n' "$label" > "$FAKE_BASE/volumes/$marker")
       fi
       echo "$marker" ;;
     rm) rm -- "$FAKE_BASE/volumes/\${!#}" ;;
   esac ;;
 network)
   if [[ $2 == ls && \${FAKE_NAME_CONFLICT:-} == network ]]; then
     for option; do
       case $option in name=*) name=\${option#name=^}; echo "\${name%\$}" ;; esac
     done
   fi ;;
 image)
   case "$2" in
     load) true ;;
     inspect) ref=\${!#}; v=\${ref#*:}; v=\${v%-amd64}; id='${webID}'; [[ $ref != neocloud-api:* ]] || id='${apiID}'; [[ \${FAKE_MANIFEST_IDS:-0} != 1 ]] || id='sha256:${"3".repeat(64)}'; echo "$id|linux|amd64|$v|${commit}" ;;
     save) if [[ \${3:-} == --help ]]; then echo '--platform'; else tar -cf - -C "$FAKE_BASE/exported" blobs; fi ;;
   esac ;;
 compose)
   if [[ -n \${NEOCLOUD_RELEASE_DATA_DIR:-} ]]; then
     printf 'compose data=%s\\n' "$NEOCLOUD_RELEASE_DATA_DIR" >> "$FAKE_LOG"
   fi
   if [[ $* == *'version --short'* ]]; then echo 2.40.0
   elif [[ $* == *'db migrate status'* ]]; then
     compatible=true; [[ \${FAKE_INCOMPATIBLE:-0} != 1 ]] || compatible=false
     printf '{"compatible":%s,"sets":[{"compatible":%s,"dirty":false,"current":1,"target":1}]}\\n' "$compatible" "$compatible"
   elif [[ $* == *' exec '* && \${FAKE_HEALTH_FAILURE:-0} == 1 && $* == *'v1.0.1'* ]]; then exit 1
   fi ;;
 run)
   if [[ $* == *'.neocloud-installation'* ]]; then
     source=$(mounted_source "$@")
     printf 'verify data mount=%s\\n' "$source" >> "$FAKE_LOG"
     while [[ $1 != node ]]; do shift; done; shift
     [[ $1 == -e ]]
     if command -v cygpath >/dev/null; then source=$(cygpath -m "$source"); fi
     # Rebase the container path and skip the root-only UID change in this fixture.
     code=\${2//\\/data/$source}
     code=\${code/'fs.chownSync('/'void ('}
     exec '${process.execPath}' -e "$code" "\${@:3}"
   elif [[ $* == *'process.stdin'* || $* == *'net.isIP'* ]]; then
     while [[ $1 != node ]]; do shift; done; shift
     exec '${process.execPath}' "$@"
   elif [[ $* == *'sh -ec'* ]]; then
     [[ \${FAKE_BACKUP_FAILURE:-0} != 1 ]] || exit 1
     if [[ \${FAKE_DATABASE_FROM_MOUNT:-0} == 1 ]]; then
       source=$(mounted_source "$@")
       tar -cf - -C "$source" app.db
     else
       tar -cf - -C "$FAKE_BASE" app.db
     fi
   elif [[ $* == *'--network host'* && \${FAKE_PORT_FAILURE:-0} == 1 ]]; then exit 1
   fi ;;
 *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  // 失败探针在控制流程夹具中立即耗尽等待窗口，不冒充真实容器启动证据。
  await writeFile(
    join(bin, "sleep"),
    "#!/usr/bin/env bash\n/bin/sleep 0.05\n",
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, "ss"),
    `#!/usr/bin/env bash
set -eu
printf 'ss %s\\n' "$*" >> "$FAKE_LOG"
if [[ -n \${FAKE_LISTEN_PORT:-} ]]; then
  printf 'LISTEN 0 511 0.0.0.0:%s 0.0.0.0:*\\n' "$FAKE_LISTEN_PORT"
fi
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    DOCKER_HOST: "unix:///fake/docker.sock",
    FAKE_LOG: log,
    FAKE_BASE: base,
    NEOCLOUD_OFFLINE_TRUST_DIR: trust,
  };
  const root = join(base, "instance");
  const run = (args, extra = {}) =>
    spawnSync("bash", [installer, ...args], {
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 25000,
    });
  async function bundle(
    version,
    { network = true, entrypoint = true, layout = true, tooling = false } = {},
  ) {
    const source = join(base, version),
      stage = join(source, "stage");
    await mkdir(stage, { recursive: true });
    await cp(installer, join(stage, "install.sh"));
    await writeFile(join(stage, "compose.yaml"), "services: {}\n");
    await writeFile(join(stage, "images.tar"), "fixture-image-archive");
    await writeFile(
      join(stage, "images.env"),
      `API_IMAGE=neocloud-api:${version}-amd64\nWEB_IMAGE=neocloud-web:${version}-amd64\n`,
    );
    await writeFile(
      join(stage, "manifest.txt"),
      `FORMAT=1\n${network ? "NETWORK=1\n" : ""}${entrypoint ? "ENTRYPOINT=1\n" : ""}${layout ? "INSTANCE_LAYOUT=1\n" : ""}${tooling ? "OFFLINE_MAINTENANCE=1\n" : ""}VERSION=${version}\nARCH=amd64\nCOMMIT=${commit}\nAPI_ID=${apiID}\nWEB_ID=${webID}\n`,
    );
    const name = `neocloud_${version}_linux_amd64_docker.tar.gz`;
    const packed = spawnSync("tar", [
      "-czf",
      join(source, name),
      "-C",
      stage,
      "compose.yaml",
      "images.env",
      "images.tar",
      "install.sh",
      "manifest.txt",
    ]);
    assert.equal(packed.status, 0);
    await cp(installer, join(source, "install.sh"));
    await writeFile(join(source, "version.txt"), `${version}\n`);
    const files = [name, "install.sh", "version.txt"];
    if (tooling) {
      const binary = `neocloud-maintenance_${version}_linux_amd64`;
      await writeFile(join(source, binary), `#!/usr/bin/env bash\nset -eu\nprintf '%s\\n' "$*"\n`);
      files.push(binary);
    }
    let checksums = "";
    for (const file of files) checksums += checksum(file, await readFile(join(source, file)));
    await writeFile(join(source, "checksums.txt"), checksums);
    await writeFile(join(source, "checksums.txt.sigstore.json"), offlineBundle);
    return source;
  }
  const install = async () => {
    const source = await bundle("v1.0.0");
    const result = run([
      "install",
      "--dir",
      root,
      "--version",
      "v1.0.0",
      "--release-dir",
      source,
    ]);
    assert.equal(result.status, 0, result.stderr);
  };
  return { base, root, log, env, run, bundle, install };
}
test("部署计划显示自定义入口和精确资源路径，且不调用 Docker 或创建目录", async (t) => {
  const f = await fixture(t);
  const root = join(await realpath(f.base), "NeoCloud instance");
  const project = "drive-preview";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const result = f.run([
    "plan",
    "--dir",
    root,
    "--name",
    project,
    "--data-dir",
    "nested/data files",
    "--bind",
    "127.0.0.1",
    "--port",
    "44217",
    "--public-url",
    "https://drive.example.test",
    "--version",
    "v1.0.0",
    "--release-dir",
    f.base,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.split("\n");
  for (const [label, expected] of [
    ["安装目录", root],
    ["数据目录", join(root, "nested", "data files")],
    ["Compose 项目", project],
    ["容器", `${project}-backend-1`],
    ["容器", `${project}-web-1`],
    ["镜像", `neocloud-api:v1.0.0-${arch}`],
    ["镜像", `neocloud-web:v1.0.0-${arch}`],
    ["网络", `${project}_default`],
    ["端口", "127.0.0.1:44217"],
    ["访问地址", "https://drive.example.test"],
  ]) {
    assert.ok(
      output.some(
        (line) => line.startsWith(`${label}：`) && line.includes(expected),
      ),
      `缺少${label} ${expected}\n${result.stdout}`,
    );
  }
  await assert.rejects(access(root), { code: "ENOENT" });
  await assert.rejects(access(f.log), { code: "ENOENT" });

  const rejected = f.run([
    "plan",
    "--dir",
    root,
    "--public-url",
    "https://user:fixture-password@drive.example.test",
    "--version",
    "v1.0.0",
  ]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /--public-url/);
  assert.doesNotMatch(rejected.stdout + rejected.stderr, /fixture-password/);
  await assert.rejects(access(root), { code: "ENOENT" });
  await assert.rejects(access(f.log), { code: "ENOENT" });
});

test("部署检查只读取 Docker 和监听状态，安装计划与部署均在下载前拦截冲突", async (t) => {
  const f = await fixture(t);
  const root = join(await realpath(f.base), "instance");
  const data = join(await realpath(f.base), "outside data");
  const curlLog = join(f.base, "curl.log");
  await writeFile(
    join(f.base, "bin", "curl"),
    `#!/usr/bin/env bash\nprintf 'unexpected request\\n' >> "$FAKE_CURL_LOG"\nexit 12\n`,
    { mode: 0o700 },
  );
  const args = [
    "--dir", root, "--name", "drive-check", "--data-dir", data,
    "--port", "4180", "--version", "v1.0.0",
  ];
  const checked = f.run(["plan", "--check", ...args], { FAKE_CURL_LOG: curlLog });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /drive-check/);
  const checkedLog = await readFile(f.log, "utf8");
  assert.match(checkedLog, /volume ls/);
  assert.match(checkedLog, /ss -H -ltn/);
  assert.doesNotMatch(checkedLog, / volume create|^volume create|image load|migrate/m);
  await assert.rejects(access(root), { code: "ENOENT" });
  await assert.rejects(access(data), { code: "ENOENT" });
  await assert.rejects(access(curlLog), { code: "ENOENT" });

  for (const [conflict, message] of [
    [{ FAKE_FOREIGN_VOLUME: "drive-check-instance" }, /drive-check-instance|同名/],
    [{ FAKE_MOUNT_SOURCE: data }, /数据目录|挂载/],
    [{ FAKE_LISTEN_PORT: "4180" }, /端口.*占[用有]|已监听/],
    [{ FAKE_CONTAINER_PORT: "4180" }, /端口.*已被容器.*发布/],
  ]) {
    for (const command of [["plan", "--check"], ["install"]]) {
      await writeFile(f.log, "");
      const rejected = f.run([...command, ...args], {
        ...conflict,
        FAKE_CURL_LOG: curlLog,
      });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, message);
      assert.doesNotMatch(await readFile(f.log, "utf8"), /volume create|image load|migrate/);
      await assert.rejects(access(root), { code: "ENOENT" });
      await assert.rejects(access(data), { code: "ENOENT" });
      await assert.rejects(access(curlLog), { code: "ENOENT" });
    }
  }

  await mkdir(data);
  const existing = join(data, "keep.txt");
  await writeFile(existing, "do not modify");
  await writeFile(f.log, "");
  const nonempty = f.run(["install", ...args], { FAKE_CURL_LOG: curlLog });
  assert.notEqual(nonempty.status, 0);
  assert.match(nonempty.stderr, /数据目录.*非空|需要空的数据目录/);
  assert.equal(await readFile(existing, "utf8"), "do not modify");
  assert.doesNotMatch(await readFile(f.log, "utf8"), /volume create|image load|migrate/);
  await assert.rejects(access(root), { code: "ENOENT" });
  await assert.rejects(access(curlLog), { code: "ENOENT" });
});

test("自定义实例名和外部空目录用于启动、重启及数据库备份", async (t) => {
  const f = await fixture(t);
  const data = join(await realpath(f.base), "external data");
  const root = join(await realpath(f.base), "instance");
  await mkdir(data);
  const source = await f.bundle("v1.0.0");
  const result = f.run([
    "install", "--dir", root, "--name", "drive-external", "--data-dir", data,
    "--bind", "127.0.0.1", "--port", "4180", "--version", "v1.0.0",
    "--release-dir", source,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /drive-external-web-1/);
  assert.equal(
    await readFile(join(root, ".control/project"), "utf8"),
    "drive-external\n",
  );
  assert.equal((await readFile(join(root, ".control/data-dir"), "utf8")).trim(), data);
  assert.equal(
    await readFile(join(root, ".control/maintenance-project"), "utf8"),
    `${projectFor(root)}\n`,
  );
  const owner = (
    await readFile(join(f.base, "volumes/drive-external-instance"), "utf8")
  ).trim();
  assert.match(owner, /^[a-f0-9]{64}$/);
  const dataMarker = join(data, ".neocloud-installation");
  assert.equal(await readFile(dataMarker, "utf8"), owner);
  await assert.rejects(access(join(root, "data")), { code: "ENOENT" });
  let log = await readFile(f.log, "utf8");
  assert.ok(log.includes(`verify data mount=${data}`), log);
  assert.ok(log.includes(`compose data=${data}`), log);

  await writeFile(join(data, "app.db"), "fixture-database-on-external-volume");
  await writeFile(f.log, "");
  for (const command of ["restart", "backup"]) {
    const managed = spawnSync("bash", [join(root, "install.sh"), command], {
      env: { ...f.env, FAKE_DATABASE_FROM_MOUNT: "1" },
      encoding: "utf8",
      timeout: 25000,
    });
    assert.equal(managed.status, 0, managed.stderr);
  }
  log = await readFile(f.log, "utf8");
  assert.ok(log.includes(`compose data=${data}`), log);
  assert.ok(log.includes(`type=bind,source=${data},target=/data,readonly`), log);
  const archive = (await readdir(join(root, "backups")))[0];
  const db = spawnSync("tar", ["-xOf", join(root, "backups", archive, "database.tar"), "app.db"], {
    encoding: "utf8",
  });
  assert.equal(db.status, 0, db.stderr);
  assert.equal(db.stdout, "fixture-database-on-external-volume");

  await writeFile(dataMarker, "foreign-owner");
  await writeFile(f.log, "");
  const rejected = f.run(["restart", "--dir", root]);
  assert.notEqual(rejected.status, 0);
  assert.match(await readFile(f.log, "utf8"), /verify data mount=/);
  assert.doesNotMatch(await readFile(f.log, "utf8"), /compose .* (up|stop|migrate)( |$)/m);
  assert.equal(await readFile(dataMarker, "utf8"), "foreign-owner");
});

test("新布局仅安装带布局能力的发布包，旧包仍接受默认安装", async (t) => {
  const f = await fixture(t);
  const source = await f.bundle("v1.0.0", { layout: false });
  const base = ["--version", "v1.0.0", "--release-dir", source];
  const rejected = f.run([
    "install", "--dir", f.root, "--name", "drive-old", "--data-dir", "nested/data", ...base,
  ]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /INSTANCE_LAYOUT|不支持.*(?:布局|目录)/);
  assert.doesNotMatch(await readFile(f.log, "utf8"), /volume create|migrate/);
  await assert.rejects(access(f.root), { code: "ENOENT" });

  const installed = f.run(["install", "--dir", f.root, ...base]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(await readFile(join(f.root, "runtime.env"), "utf8"), /^WEB_PORT=4173$/m);
});

test("下载校验失败不会创建实例或执行迁移", async (t) => {
  const f = await fixture(t),
    source = await f.bundle("v1.0.0");
  await writeFile(
    join(source, "checksums.txt"),
    (await readFile(join(source, "checksums.txt"), "utf8")).replace(/^[a-f0-9]{64}/, "0".repeat(64)),
  );
  const r = f.run([
    "install",
    "--dir",
    f.root,
    "--version",
    "v1.0.0",
    "--release-dir",
    source,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /摘要不匹配/);
  assert.doesNotMatch(await readFile(f.log, "utf8"), /migrate| stop/);
});
test("containerd 显示 ID 不同仍以原始配置摘要验证镜像，损坏配置禁止迁移", async (t) => {
  const f = await fixture(t),
    source = await f.bundle("v1.0.0");
  const args = [
    "install",
    "--dir",
    f.root,
    "--version",
    "v1.0.0",
    "--release-dir",
    source,
  ];
  const result = f.run(args, { FAKE_MANIFEST_IDS: "1" });
  assert.equal(result.status, 0, result.stderr);
  const g = await fixture(t),
    corrupt = await g.bundle("v1.0.0");
  await writeFile(
    join(g.base, "exported/blobs/sha256", apiID.slice(7)),
    "corrupted",
  );
  const rejected = g.run(
    [
      "install",
      "--dir",
      g.root,
      "--version",
      "v1.0.0",
      "--release-dir",
      corrupt,
    ],
    { FAKE_MANIFEST_IDS: "1" },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /配置内容摘要不匹配/);
  assert.doesNotMatch(await readFile(g.log, "utf8"), /migrate| stop/);
});
test("安装不接管非空目录，端口冲突发生在迁移前", async (t) => {
  const f = await fixture(t);
  await mkdir(f.root);
  await writeFile(join(f.root, "keep"), "user-data");
  assert.notEqual(f.run(["install", "--dir", f.root]).status, 0);
  assert.equal(await readFile(join(f.root, "keep"), "utf8"), "user-data");
  const source = await f.bundle("v1.0.0");
  const r = f.run(
    [
      "install",
      "--dir",
      join(f.base, "occupied"),
      "--version",
      "v1.0.0",
      "--release-dir",
      source,
    ],
    { FAKE_PORT_FAILURE: "1" },
  );
  assert.match(r.stderr, /端口已占用/);
  assert.doesNotMatch(
    await readFile(f.log, "utf8"),
    /run --rm --no-deps migrate/,
  );
});
test("同名 Compose 容器或网络在首次安装前拒绝接管", async (t) => {
  for (const [type, suffix] of [
    ["project-container", "-other-1"],
    ["exact-container", "-web-1"],
    ["network", "_default"],
  ]) {
    const f = await fixture(t);
    const root = join(await realpath(f.base), "instance");
    const result = f.run(
      ["install", "--dir", root, "--version", "v1.0.0", "--release-dir", f.base],
      { FAKE_NAME_CONFLICT: type },
    );
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(projectFor(root) + suffix), result.stderr);
    assert.doesNotMatch(
      await readFile(f.log, "utf8"),
      /image load|migrate| up | stop/,
    );
    await assert.rejects(access(root), { code: "ENOENT" });
  }
});
test("重复安装幂等，升级先备份再迁移且保留私有配置", async (t) => {
  const f = await fixture(t);
  await f.install();
  const original = await readFile(join(f.root, "runtime.env"));
  const initial = await readFile(f.log, "utf8");
  assert.equal(f.run(["install", "--dir", f.root]).status, 0);
  assert.equal(
    await readFile(f.log, "utf8"),
    initial +
      "info\ncompose version --short\ninfo --format {{.OSType}}\ninfo --format {{.Architecture}}\n",
  );
  const source = await f.bundle("v1.0.1");
  const r = f.run([
    "upgrade",
    "--dir",
    f.root,
    "--version",
    "v1.0.1",
    "--release-dir",
    source,
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    await readFile(join(f.root, ".control/current"), "utf8"),
    "v1.0.1\n",
  );
  assert.deepEqual(await readFile(join(f.root, "runtime.env")), original);
  const log = await readFile(f.log, "utf8");
  assert.ok(
    log.indexOf("sh -ec") <
      log.lastIndexOf("v1.0.1/compose.yaml run --rm --no-deps migrate"),
  );
});
test("备份失败不执行目标迁移，兼容旧服务恢复", async (t) => {
  const f = await fixture(t);
  await f.install();
  await writeFile(f.log, "");
  const source = await f.bundle("v1.0.1");
  const r = f.run(
    [
      "upgrade",
      "--dir",
      f.root,
      "--version",
      "v1.0.1",
      "--release-dir",
      source,
    ],
    { FAKE_BACKUP_FAILURE: "1" },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /没有执行迁移/);
  assert.doesNotMatch(
    await readFile(f.log, "utf8"),
    /v1\.0\.1\/compose.yaml run --rm --no-deps migrate/,
  );
  assert.equal(
    await readFile(join(f.root, ".control/current"), "utf8"),
    "v1.0.0\n",
  );
});
test("status 的 compatible=false 即使退出码为零也禁止恢复旧镜像", async (t) => {
  const f = await fixture(t);
  await f.install();
  await writeFile(f.log, "");
  const source = await f.bundle("v1.0.1");
  const r = f.run(
    [
      "upgrade",
      "--dir",
      f.root,
      "--version",
      "v1.0.1",
      "--release-dir",
      source,
    ],
    { FAKE_INCOMPATIBLE: "1" },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /未自动回退数据库/);
  assert.doesNotMatch(
    await readFile(f.log, "utf8"),
    /v1\.0\.0\/compose.yaml up --detach/,
  );
});
test("直接管道安装只解析一次最新稳定版，全部发布资产使用固定 tag", async (t) => {
  const f = await fixture(t);
  const source = await f.bundle("v1.0.0");
  await mkdir(join(f.root, "nested", "storage files"), { recursive: true });
  const requests = join(f.base, "curl.log");
  await writeFile(
    join(f.base, "bin/curl"),
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
const url=args.find(x=>x.startsWith('https://'));
fs.appendFileSync(process.env.FAKE_CURL_LOG,url+'\\n');
if(url.endsWith('/download/install.sh')) process.stdout.write(fs.readFileSync(path.join(process.env.FAKE_ASSETS,'stage','install.sh')));
else if(url.endsWith('/releases/latest')) process.stdout.write('https://github.com/reina0721/neocloud/releases/tag/v1.0.0');
else fs.copyFileSync(path.join(process.env.FAKE_ASSETS,path.basename(url)),args[args.indexOf('--output')+1]);
`,
    { mode: 0o700 },
  );
  const bootstrap =
    "https://github.com/reina0721/neocloud/releases/latest/download/install.sh";
  const result = spawnSync(
    "bash",
    [
      "-o",
      "pipefail",
      "-c",
      'curl -fsSL "$1" | bash -s -- install --dir "$2" --name drive-pipe --data-dir "nested/storage files" --bind 127.0.0.1 --port 4180',
      "_",
      bootstrap,
      f.root,
    ],
    {
      env: { ...f.env, FAKE_CURL_LOG: requests, FAKE_ASSETS: source },
      encoding: "utf8",
      timeout: 25000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const config = await readFile(join(f.root, "runtime.env"), "utf8");
  assert.match(config, /^WEB_BIND=127\.0\.0\.1$/m);
  assert.match(config, /^WEB_PORT=4180$/m);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:4180\/setup/);
  assert.equal((await readFile(join(f.root, ".control/project"), "utf8")).trim(), "drive-pipe");
  const data = join(await realpath(f.root), "nested", "storage files");
  assert.equal((await readFile(join(f.root, ".control/data-dir"), "utf8")).trim(), data);
  await access(data);
  assert.deepEqual((await readFile(requests, "utf8")).trim().split("\n"), [
    bootstrap,
    "https://github.com/reina0721/neocloud/releases/latest",
    "https://github.com/reina0721/neocloud/releases/download/v1.0.0/checksums.txt",
    "https://github.com/reina0721/neocloud/releases/download/v1.0.0/checksums.txt.sigstore.json",
    "https://github.com/reina0721/neocloud/releases/download/v1.0.0/neocloud_v1.0.0_linux_amd64_docker.tar.gz",
  ]);
  const blocked = join(f.base, "blocked-online-install");
  await writeFile(requests, "");
  const invalid = f.run(["install", "--dir", blocked, "--version", "v1.0.0"], {
    FAKE_CURL_LOG: requests,
    FAKE_ASSETS: source,
    FAKE_SIGNATURE_FAILURE: "1",
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /正式发布签名验证失败/);
  assert.doesNotMatch(await readFile(requests, "utf8"), /docker\.tar\.gz/);
  await assert.rejects(access(blocked), { code: "ENOENT" });
});
test("目标版本启动超时仅在旧数据库兼容时恢复旧服务", async (t) => {
  const f = await fixture(t);
  await f.install();
  const source = await f.bundle("v1.0.1");
  const result = f.run(
    [
      "upgrade",
      "--dir",
      f.root,
      "--version",
      "v1.0.1",
      "--release-dir",
      source,
      "--wait-timeout",
      "5",
    ],
    { FAKE_HEALTH_FAILURE: "1" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /就绪\/版本检查未通过/);
  assert.match(result.stderr, /与当前数据库兼容，已恢复旧服务/);
  assert.equal(
    await readFile(join(f.root, ".control/current"), "utf8"),
    "v1.0.0\n",
  );
});

test("高级入口仍可明确配置，升级保持网络配置", async (t) => {
  const f = await fixture(t),
    source = await f.bundle("v1.0.0");
  const result = f.run([
    "install",
    "--dir",
    f.root,
    "--version",
    "v1.0.0",
    "--release-dir",
    source,
    "--bind",
    "0.0.0.0",
    "--port",
    "44173",
    "--public-url",
    "http://198.51.100.10:18080",
    "--allow-http",
    "--allow-origin",
    "https://files.example.test",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const configuration = await readFile(join(f.root, "runtime.env"), "utf8");
  assert.match(configuration, /^WEB_BIND=0\.0\.0\.0$/m);
  assert.match(
    configuration,
    /^PUBLIC_ORIGIN=http:\/\/198\.51\.100\.10:18080$/m,
  );
  assert.match(configuration, /^ALLOW_INSECURE_HTTP=true$/m);
  assert.match(configuration, /https:\/\/files\.example\.test/);
  const target = await f.bundle("v1.0.1");
  const upgrade = f.run([
    "upgrade",
    "--dir",
    f.root,
    "--version",
    "v1.0.1",
    "--release-dir",
    target,
  ]);
  assert.equal(upgrade.status, 0, upgrade.stderr);
  assert.equal(
    await readFile(join(f.root, "runtime.env"), "utf8"),
    configuration,
  );
});

test("拒绝不明确或可注入的入口，在迁移前终止", async (t) => {
  for (const options of [
    ["--public-url", "https://files.example.test/path"],
    ["--public-url", "https://user:secret@files.example.test"],
    ["--bind", "bad-ip", "--public-url", "https://files.example.test"],
    ["--public-url", "https://files.example.test/"],
    ["--public-url", "https://files.example.test\nWEB_BIND=0.0.0.0"],
    ["--public-url", "https://files.example.test", "--allow-origin", "*"],
  ]) {
    const f = await fixture(t),
      source = await f.bundle("v1.0.0");
    const result = f.run([
      "install",
      "--dir",
      f.root,
      "--version",
      "v1.0.0",
      "--release-dir",
      source,
      ...options,
    ]);
    assert.notEqual(result.status, 0, JSON.stringify(options));
    assert.doesNotMatch(
      await readFile(f.log, "utf8"),
      /run --rm --no-deps migrate/,
    );
  }
});

test("基础安装默认 HTTP 与所有地址，无需外部地址；管理命令定位自身目录", async (t) => {
  const f = await fixture(t);
  await f.install();
  const configuration = await readFile(join(f.root, "runtime.env"), "utf8");
  assert.match(configuration, /^WEB_BIND=0\.0\.0\.0$/m);
  assert.match(configuration, /^WEB_PORT=4173$/m);
  assert.match(configuration, /^ALLOW_INSECURE_HTTP=true$/m);
  assert.match(configuration, /^PUBLIC_ORIGIN=$/m);
  assert.match(configuration, /^ALLOWED_ORIGINS='\[\]'$/m);
  const manager = join(f.root, "install.sh");
  for (const args of [
    ["status"],
    ["restart"],
    ["logs", "--tail", "12", "-f"],
  ]) {
    const result = spawnSync("bash", [manager, ...args], {
      cwd: "/tmp",
      env: { ...process.env, ...f.env },
      encoding: "utf8",
      timeout: 25000,
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const log = await readFile(f.log, "utf8");
  assert.match(log, /logs --tail 12 --follow backend web/);
  assert.deepEqual(
    await readFile(join(f.root, "runtime.env"), "utf8"),
    configuration,
  );
  const target = await f.bundle("v1.0.1");
  assert.equal(
    f.run([
      "update",
      "--dir",
      f.root,
      "--version",
      "v1.0.1",
      "--release-dir",
      target,
    ]).status,
    0,
  );
});

test("新自动入口不能降级到缺少能力的包，校验发生在停服前", async (t) => {
  const f = await fixture(t);
  await f.install();
  const old = await f.bundle("v1.0.1", { entrypoint: false });
  await writeFile(f.log, "");
  const result = f.run([
    "upgrade",
    "--dir",
    f.root,
    "--version",
    "v1.0.1",
    "--release-dir",
    old,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不支持自动同源入口/);
  assert.doesNotMatch(
    await readFile(f.log, "utf8"),
    / stop|run --rm --no-deps migrate/,
  );
});

function terminal(args, answers, env, piped = false) {
  // 真实伪终端：覆盖 curl|bash 的 /dev/tty 输入，不把普通 stdin 冒充终端。
  return spawnSync(
    "python3",
    [
      "-c",
      `
import os,pty,select,sys,json,time,signal
args,answers,piped=json.loads(sys.argv[1])
pid,fd=pty.fork()
if pid==0:
    if piped:os.execvp('bash',['bash','-c','cat "$1" | bash -s -- "\u0024{@:2}"','_',*args])
    os.execvp('bash',['bash',*args])
os.write(fd,('\\n'.join(answers)+'\\n').encode())
output=bytearray();deadline=time.monotonic()+22;status=None
while time.monotonic()<deadline:
    if select.select([fd],[],[],.1)[0]:
        try:
            chunk=os.read(fd,65536)
            if not chunk:break
            output.extend(chunk)
        except OSError:break
    ended,value=os.waitpid(pid,os.WNOHANG)
    if ended:status=value;break
if status is None:
    ended,value=os.waitpid(pid,os.WNOHANG)
    if not ended:
        os.killpg(pid,signal.SIGKILL);os.waitpid(pid,0);sys.stdout.buffer.write(output);sys.exit(124)
    status=value
sys.stdout.buffer.write(output);sys.exit(os.waitstatus_to_exitcode(status))
`,
      JSON.stringify([args, answers, piped]),
    ],
    { env, encoding: "utf8", timeout: 25000 },
  );
}

test("管道安装使用真实终端并可跳过网页运维", async (t) => {
  const f = await fixture(t),
    source = await f.bundle("v1.0.0");
  const result = terminal(
    [installer, "--version", "v1.0.0", "--release-dir", source],
    [f.root, "0.0.0.0", "44173", "y", "n"],
    { ...f.env, HOME: f.base },
    true,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /安装目录/);
  assert.match(result.stdout, /安装完成/);
  assert.match(
    await readFile(join(f.root, "runtime.env"), "utf8"),
    /^WEB_PORT=44173$/m,
  );
  const before = await readFile(join(f.root, "runtime.env"));
  const menu = terminal([join(f.root, "install.sh")], ["1", "0"], f.env);
  assert.equal(menu.status, 0, menu.stdout + menu.stderr);
  assert.match(menu.stdout, /当前版本：v1.0.0/);
  assert.deepEqual(await readFile(join(f.root, "runtime.env")), before);
});

test("无终端不等待输入；--yes 使用 HOME 下默认目录", async (t) => {
  const f = await fixture(t),
    source = await f.bundle("v1.0.0");
  const noTerminal = spawnSync("setsid", ["bash", installer], {
    env: f.env,
    encoding: "utf8",
    timeout: 3000,
  });
  assert.equal(noTerminal.status, 2, noTerminal.stderr);
  assert.match(noTerminal.stderr, /没有交互终端/);
  const installed = f.run(
    ["--yes", "--version", "v1.0.0", "--release-dir", source],
    { HOME: f.base },
  );
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(
    (
      await readFile(join(f.base, "neocloud/.control/current"), "utf8")
    ).trim(),
    "v1.0.0",
  );
});

test("IPv6 监听使用 Compose 的方括号格式，HTTPS 默认保持安全 Cookie", async (t) => {
  const f = await fixture(t),
    source = await f.bundle("v1.0.0");
  const result = f.run([
    "install",
    "--dir",
    f.root,
    "--version",
    "v1.0.0",
    "--release-dir",
    source,
    "--bind",
    "::",
    "--public-url",
    "https://files.example.test",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/files\.example\.test\/setup/);
  const configuration = await readFile(join(f.root, "runtime.env"), "utf8");
  assert.match(configuration, /^WEB_BIND=\[::\]$/m);
  assert.match(configuration, /^ALLOW_INSECURE_HTTP=false$/m);
});

test("旧包不能假装支持外部入口，已有网络配置不向旧包升级", async (t) => {
  const f = await fixture(t);
  const old = await f.bundle("v1.0.0", { network: false });
  const install = f.run([
    "install",
    "--dir",
    f.root,
    "--version",
    "v1.0.0",
    "--release-dir",
    old,
    "--public-url",
    "http://198.51.100.10:4173",
    "--allow-http",
  ]);
  assert.notEqual(install.status, 0);
  assert.match(install.stderr, /不支持网络配置/);
  assert.doesNotMatch(
    await readFile(f.log, "utf8"),
    /run --rm --no-deps migrate/,
  );
  await f.install();
  const original = await readFile(join(f.root, "runtime.env"));
  await writeFile(f.log, "");
  const target = await f.bundle("v1.0.1", { network: false });
  const upgrade = f.run([
    "upgrade",
    "--dir",
    f.root,
    "--version",
    "v1.0.1",
    "--release-dir",
    target,
  ]);
  assert.notEqual(upgrade.status, 0);
  assert.match(upgrade.stderr, /不支持网络配置/);
  assert.doesNotMatch(
    await readFile(f.log, "utf8"),
    / stop|run --rm --no-deps migrate/,
  );
  assert.deepEqual(await readFile(join(f.root, "runtime.env")), original);
});

test("启用网页运维使用正式版签名校验，并执行摘要匹配的宿主工具", async (t) => {
  const f = await fixture(t);
  await f.install();
  const source = join(f.base, "v1.0.0");
  const binary = "neocloud-maintenance_v1.0.0_linux_amd64";
  const script =
    "#!/usr/bin/env bash\nset -eu\n[[ $1 == enable && $2 == --root ]]\nprintf 'maintenance fixture\\n'\n";
  const digest = createHash("sha256").update(script).digest("hex");
  const manifest = join(source, "checksums.txt");
  await writeFile(join(source, binary), script);
  await writeFile(
    manifest,
    (await readFile(manifest, "utf8")) + digest + "  " + binary + "\n",
  );
  await writeFile(
    join(f.base, "bin", "cosign"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ $# == 12 && $1 == verify-blob && $2 == --bundle && -f $3 ]]
[[ $4 == --certificate-identity && $5 == https://github.com/reina0721/neocloud/.github/workflows/release.yml@refs/tags/v1.0.0 ]]
[[ $6 == --certificate-oidc-issuer && $7 == https://token.actions.githubusercontent.com ]]
[[ $8 == --offline && $9 == --new-bundle-format && \${10} == --trusted-root && -f \${11} && -f \${12} ]]
`,
    { mode: 0o700 },
  );
  for (const command of ["systemctl", "sudo"]) {
    await writeFile(
      join(f.base, "bin", command),
      "#!/usr/bin/env bash\nexit 99\n",
      { mode: 0o700 },
    );
  }
  const result = f.run([
    "enable-web-management",
    "--dir",
    f.root,
    "--release-dir",
    source,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /maintenance fixture/);
  await writeFile(join(source, binary), script + "# altered\n");
  const altered = f.run([
    "enable-web-management",
    "--dir",
    f.root,
    "--release-dir",
    source,
  ]);
  assert.notEqual(altered.status, 0);
  assert.match(altered.stderr, /维护.*摘要不匹配|maintenance_.*摘要不匹配/);
  assert.doesNotMatch(altered.stdout, /maintenance fixture/);
});

test("离线检查验证完整包，坏签名和旧目标在停服前拒绝", async (t) => {
  const f = await fixture(t);
  await f.install();
  const next = await f.bundle("v1.0.1");
  const old = await f.bundle("v0.9.0");
  await writeFile(f.log, "");
  const checked = f.run(["check-update", "--dir", f.root, "--release-dir", next]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /v1\.0\.1（可升级）/);
  const invalid = f.run(["upgrade", "--dir", f.root, "--release-dir", next], { FAKE_SIGNATURE_FAILURE: "1" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /离线签名验证失败/);
  const downgrade = f.run(["upgrade", "--dir", f.root, "--release-dir", old]);
  assert.notEqual(downgrade.status, 0);
  assert.match(downgrade.stderr, /只接受更新版本/);
  assert.doesNotMatch(await readFile(f.log, "utf8"), /image load| stop|run --rm --no-deps migrate/);
  assert.equal(await readFile(join(f.root, ".control/current"), "utf8"), "v1.0.0\n");
});

test("旧包即使使用 NeoCloud 项目名，也在 Docker 和维护入口执行前被拒绝", async (t) => {
  const f = await fixture(t);
  const control = join(f.root, ".control");
  const release = join(f.root, "releases", "v0.3.4");
  const images = "API_IMAGE=clouddrive-api:v0.3.4-amd64\nWEB_IMAGE=clouddrive-web:v0.3.4-amd64\n";
  await mkdir(control, { recursive: true });
  await mkdir(release, { recursive: true });
  await writeFile(join(control, "project"), `${projectFor(await realpath(f.root))}\n`);
  await writeFile(join(release, "images.env"), images);
  await writeFile(f.log, "");

  for (const [marker, commands] of [
    ["current", [[], ["upgrade"], ["restart"]]],
    ["candidate", [["install"]]],
  ]) {
    const record = join(control, marker);
    await writeFile(record, "v0.3.4\n");
    for (const command of commands) {
      const rejected = f.run([...command, "--dir", `${f.root}/missing/..`]);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /v0\.3\.4 的镜像引用不符合 NeoCloud 发布格式/);
    }
    assert.equal(await readFile(record, "utf8"), "v0.3.4\n");
    await rm(record);
  }

  assert.equal(await readFile(f.log, "utf8"), "");
  assert.equal(await readFile(join(release, "images.env"), "utf8"), images);
  await assert.rejects(access(join(control, "lock")), { code: "ENOENT" });
});

test("离线升级从签名包安装共用维护入口并传入明确的离线版本", async (t) => {
  const f = await fixture(t);
  await f.install();
  const next = await f.bundle("v1.0.1", { tooling: true });
  await writeFile(f.log, "");
  const result = f.run(["upgrade", "--dir", f.root, "--release-dir", next]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local --root .* --action upgrade --target v1\.0\.1 --confirm\s+--offline/);
  assert.equal(await readFile(join(f.root, ".control/maintenance/offline-tool"), "utf8"), "v1.0.1\n");
  assert.doesNotMatch(await readFile(f.log, "utf8"), /image load| stop|run --rm --no-deps migrate/);
});

test("首次安装中断后以原候选回读，拒绝把不同离线包当作重试", async (t) => {
  const f = await fixture(t);
  const original = await f.bundle("v1.0.0");
  const other = await f.bundle("v1.0.1");
  const args = ["install", "--dir", f.root, "--release-dir"];
  const failed = f.run([...args, original], { FAKE_INCOMPATIBLE: "1" });
  assert.notEqual(failed.status, 0);
  assert.equal(await readFile(join(f.root, ".control/candidate"), "utf8"), "v1.0.0\n");
  await writeFile(f.log, "");
  const rejected = f.run([...args, other]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /与离线目录 version\.txt 不一致/);
  assert.doesNotMatch(await readFile(f.log, "utf8"), /image load|run --rm --no-deps migrate/);

  // 模拟首次安装在记录候选后、原子保存签名包前中断。
  await rm(join(f.root, "releases", "v1.0.0"), { recursive: true });
  const status = f.run(["status", "--dir", f.root]);
  assert.match(status.stderr, /镜像引用不符合 NeoCloud 发布格式/);
  const unsigned = f.run([...args, original], { FAKE_SIGNATURE_FAILURE: "1" });
  assert.match(unsigned.stderr, /离线签名验证失败/);
  await assert.rejects(access(join(f.root, "releases", "v1.0.0")), { code: "ENOENT" });

  const retried = f.run([...args, original]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(await readFile(join(f.root, ".control/current"), "utf8"), "v1.0.0\n");
});
