// 在自有隔离目录验收实际 Linux amd64 归档，不消费宿主 APP_* 配置。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const { values } = parseArgs({ options: { archive: { type: "string" } } });
assert.ok(values.archive, "需要 --archive");
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
const directory = await mkdtemp(join(tmpdir(), "clouddrive-go-archive-"));
await writeFile(join(directory, ".test-owner"), "go-archive-test-v1", {
  mode: 0o600,
});
let child,
  closed,
  ok = false;
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function stop() {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    return await closed;
  } finally {
    clearTimeout(timer);
  }
}
try {
  execFileSync("tar", [
    "-xzf",
    resolve(values.archive),
    "--no-same-owner",
    "-C",
    directory,
  ]);
  execFileSync("chmod", ["-R", "u+rwX", directory]);
  await copyFile(
    join(directory, "config.example.yaml"),
    join(directory, "config.yaml"),
  );
  await mkdir(join(directory, ".data"), { mode: 0o700 });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("APP_")),
  );
  env.APP_HTTP__ADDR = `127.0.0.1:${await freePort()}`;
  env.APP_MANAGEMENT__ADDR = `127.0.0.1:${await freePort()}`;
  const binary = join(directory, "clouddrive");
  assert.match(
    execFileSync(binary, ["--help"], { cwd: directory, env, encoding: "utf8" }),
    /自托管文件管理与分享协作工作区/,
  );
  execFileSync(binary, ["db", "migrate", "up"], {
    cwd: directory,
    env,
    stdio: "pipe",
    encoding: "utf8",
  });
  child = spawn(binary, [], {
    cwd: directory,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let processError;
  child.once("error", (error) => {
    processError = error;
  });
  closed = new Promise((done) =>
    child.once("close", (...result) => done(result)),
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors = (errors + chunk).slice(-16000);
  });
  let ready = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (processError)
      throw new Error("无法启动归档服务", { cause: processError });
    if (child.exitCode !== null) throw new Error(`归档服务提前退出：${errors}`);
    try {
      const response = await fetch(
        `http://${env.APP_MANAGEMENT__ADDR}/readyz`,
        { signal: AbortSignal.timeout(1000) },
      );
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* 服务尚未就绪，保持有界等待。 */
    }
    await delay(100);
  }
  assert.ok(ready, `归档服务没有就绪：${errors}`);
  const [code] = await stop();
  assert.equal(code, 0, "归档服务未正常停止");
  ok = true;
  console.log(
    "Go 归档通过：独立目录、默认语言资源、配置、迁移、就绪与正常停止。",
  );
} finally {
  await stop();
  if (ok) await rm(directory, { recursive: true, force: true });
  else console.error("保留 Go 归档失败现场：" + directory);
}
