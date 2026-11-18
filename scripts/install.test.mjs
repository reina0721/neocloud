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
const apiConfig =
    '{"os":"linux","architecture":"amd64","config":{"Image":"api"}}',
  webConfig = '{"os":"linux","architecture":"amd64","config":{"Image":"web"}}';
const apiID = "sha256:" + createHash("sha256").update(apiConfig).digest("hex"),
  webID = "sha256:" + createHash("sha256").update(webConfig).digest("hex");
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "clouddrive-installer-unit-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bin = join(base, "bin"),
    log = join(base, "docker.log");
  await mkdir(bin);
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
case "$1" in
 info) case "\${*:2}" in *Architecture*) echo amd64 ;; *OSType*) echo linux ;; *) true ;; esac ;;
 context) echo unix:///fake/docker.sock ;;
 image)
   case "$2" in
     load) true ;;
     inspect) ref=\${!#}; v=\${ref#*:}; v=\${v%-amd64}; id='${webID}'; [[ $ref != clouddrive-api:* ]] || id='${apiID}'; [[ \${FAKE_MANIFEST_IDS:-0} != 1 ]] || id='sha256:${"3".repeat(64)}'; echo "$id|linux|amd64|$v|${commit}" ;;
     save) if [[ \${3:-} == --help ]]; then echo '--platform'; else tar -cf - -C "$FAKE_BASE/exported" blobs; fi ;;
   esac ;;
 compose)
   if [[ $* == *'version --short'* ]]; then echo 2.40.0
   elif [[ $* == *'db migrate status'* ]]; then
     compatible=true; [[ \${FAKE_INCOMPATIBLE:-0} != 1 ]] || compatible=false
     printf '{"compatible":%s,"sets":[{"compatible":%s,"dirty":false,"current":1,"target":1}]}\\n' "$compatible" "$compatible"
   elif [[ $* == *' exec '* && \${FAKE_HEALTH_FAILURE:-0} == 1 && $* == *'v1.0.1'* ]]; then exit 1
   fi ;;
 run)
   if [[ $* == *'process.stdin'* || $* == *'net.isIP'* ]]; then
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
  async function bundle(version, { network = true, entrypoint = true } = {}) {
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
      `FORMAT=1\n${network ? "NETWORK=1\n" : ""}${entrypoint ? "ENTRYPOINT=1\n" : ""}VERSION=${version}\nARCH=amd64\nCOMMIT=${commit}\nAPI_ID=${apiID}\nWEB_ID=${webID}\n`,
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
  return { base, root, log, env, run, bundle, install };
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
      await readFile(join(f.base, "clouddrive/.control/current"), "utf8")
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
  const binary = "clouddrive-maintenance_v1.0.0_linux_amd64";
  const script =
    "#!/usr/bin/env bash\nset -eu\n[[ $1 == enable && $2 == --root ]]\nprintf 'maintenance fixture\\n'\n";
  const digest = createHash("sha256").update(script).digest("hex");
  const manifest = join(source, "checksums.txt");
  await writeFile(join(source, binary), script);
  await writeFile(
    manifest,
    (await readFile(manifest, "utf8")) + digest + "  " + binary + "\n",
  );
  await writeFile(join(source, "checksums.txt.sigstore.json"), "{}\n");
  await writeFile(
    join(f.base, "bin", "cosign"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ $# == 8 && $1 == verify-blob && $2 == --bundle && -f $3 ]]
[[ $4 == --certificate-identity && $5 == https://github.com/reina0721/neocloud/.github/workflows/release.yml@refs/tags/v1.0.0 ]]
[[ $6 == --certificate-oidc-issuer && $7 == https://token.actions.githubusercontent.com && -f $8 ]]
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
  assert.match(altered.stderr, /维护工具摘要不匹配/);
  assert.doesNotMatch(altered.stdout, /maintenance fixture/);
});
