import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const installer = resolve("install.sh");
const commit = "a".repeat(40);
const apiID = "sha256:" + "1".repeat(64),
  webID = "sha256:" + "2".repeat(64);
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "clouddrive-installer-unit-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bin = join(base, "bin"),
    log = join(base, "docker.log");
  await mkdir(bin);
  await writeFile(join(base, "app.db"), "fixture-database");
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1" in
 info) case "\${*:2}" in *Architecture*) echo amd64 ;; *OSType*) echo linux ;; *) true ;; esac ;;
 context) echo unix:///fake/docker.sock ;;
 image)
   case "$2" in
     load) true ;;
     inspect) ref=\${!#}; v=\${ref#*:}; v=\${v%-amd64}; id='${webID}'; [[ $ref != clouddrive-api:* ]] || id='${apiID}'; echo "$id|linux|amd64|$v|${commit}" ;;
   esac ;;
 compose)
   if [[ $* == *'version --short'* ]]; then echo 2.40.0
   elif [[ $* == *'db migrate status'* ]]; then
     compatible=true; [[ \${FAKE_INCOMPATIBLE:-0} != 1 ]] || compatible=false
     printf '{"compatible":%s,"sets":[{"compatible":%s,"dirty":false,"current":1,"target":1}]}\\n' "$compatible" "$compatible"
   elif [[ $* == *' exec '* && \${FAKE_HEALTH_FAILURE:-0} == 1 && $* == *'v1.0.1'* ]]; then exit 1
   fi ;;
 run)
   if [[ $* == *'process.stdin'* ]]; then
     while [[ $1 != node ]]; do shift; done; shift
     exec '${process.execPath}' "$@"
   elif [[ $* == *'sh -ec'* ]]; then
     [[ \${FAKE_BACKUP_FAILURE:-0} != 1 ]] || exit 1
     tar -cf - -C "$FAKE_BASE" app.db
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
  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    DOCKER_HOST: "unix:///fake/docker.sock",
    FAKE_LOG: log,
    FAKE_BASE: base,
  };
  const root = join(base, "instance");
  const run = (args, extra = {}) =>
    spawnSync("bash", [installer, ...args], {
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 25000,
    });
  async function bundle(version) {
    const source = join(base, version),
      stage = join(source, "stage");
    await mkdir(stage, { recursive: true });
    await cp(installer, join(stage, "install.sh"));
    await writeFile(join(stage, "compose.yaml"), "services: {}\n");
    await writeFile(join(stage, "images.tar"), "fixture-image-archive");
    await writeFile(
      join(stage, "images.env"),
      `API_IMAGE=clouddrive-api:${version}-amd64\nWEB_IMAGE=clouddrive-web:${version}-amd64\n`,
    );
    await writeFile(
      join(stage, "manifest.txt"),
      `FORMAT=1\nVERSION=${version}\nARCH=amd64\nCOMMIT=${commit}\nAPI_ID=${apiID}\nWEB_ID=${webID}\n`,
    );
    const name = `clouddrive_${version}_linux_amd64_docker.tar.gz`;
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
    const hash = createHash("sha256")
      .update(await readFile(join(source, name)))
      .digest("hex");
    await writeFile(join(source, "checksums.txt"), hash + "  " + name + "\n");
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
  return { base, root, log, run, bundle, install };
}
test("下载校验失败不会创建实例或执行迁移", async (t) => {
  const f = await fixture(t),
    source = await f.bundle("v1.0.0");
  await writeFile(
    join(source, "checksums.txt"),
    "0".repeat(64) + "  clouddrive_v1.0.0_linux_amd64_docker.tar.gz\n",
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
test("最新稳定版只解析一次，全部资产使用固定 tag", async (t) => {
  const f = await fixture(t);
  const source = await f.bundle("v1.0.0");
  const requests = join(f.base, "curl.log");
  await writeFile(
    join(f.base, "bin/curl"),
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
const url=args.find(x=>x.startsWith('https://'));
fs.appendFileSync(process.env.FAKE_CURL_LOG,url+'\\n');
if(url.endsWith('/releases/latest')) process.stdout.write('https://github.com/reina0721/neocloud/releases/tag/v1.0.0');
else fs.copyFileSync(path.join(process.env.FAKE_ASSETS,path.basename(url)),args[args.indexOf('--output')+1]);
`,
    { mode: 0o700 },
  );
  const result = f.run(["install", "--dir", f.root], {
    FAKE_CURL_LOG: requests,
    FAKE_ASSETS: source,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readFile(requests, "utf8")).trim().split("\n"), [
    "https://github.com/reina0721/neocloud/releases/latest",
    "https://github.com/reina0721/neocloud/releases/download/v1.0.0/checksums.txt",
    "https://github.com/reina0721/neocloud/releases/download/v1.0.0/clouddrive_v1.0.0_linux_amd64_docker.tar.gz",
  ]);
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
