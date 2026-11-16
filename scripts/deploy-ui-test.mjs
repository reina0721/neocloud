#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Credentials and acceptance data are local, private, and never part of the images.
process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const state = join(root, ".data", "ui-production-control");
const data = join(root, ".data", "ui-production");
const { values } = parseArgs({
  options: {
    build: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "node scripts/deploy-ui-test.mjs [--build]\n构建/启动独立 Docker 生产测试环境，保留账号与数据。Docker 需要 sudo 时设置 CLOUDDRIVE_DOCKER_SUDO=1。",
  );
  process.exit(0);
}
const port = (name, fallback) => {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1024 || n > 65535)
    throw new Error(`${name}: 无效端口`);
  return n;
};
const webPort = port("CLOUDDRIVE_UI_WEB_PORT", 4194);
const apiPort = port("CLOUDDRIVE_UI_API_PORT", 8130);
const managementPort = port("CLOUDDRIVE_UI_MANAGEMENT_PORT", 9130);
if (new Set([webPort, apiPort, managementPort]).size !== 3)
  throw new Error("三个端口必须不同");
const origin = `http://127.0.0.1:${webPort}`;
const api = `http://127.0.0.1:${apiPort}`;
const accessPath = join(state, "access.json");
const compose = ["compose", "--env-file", join(state, "compose.env"), "--file", "compose.ui-test.yaml"];
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
function run(command, args) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      signal: controller.signal,
    });
    child.once("error", fail);
    child.once("exit", (code, signal) =>
      code === 0
        ? done()
        : fail(new Error(`${command} 退出 (${signal ?? code})`)),
    );
  });
}
function docker(args) {
  return process.env.CLOUDDRIVE_DOCKER_SUDO === "1"
    ? run("sudo", ["-n", "docker", ...args])
    : run("docker", args);
}
async function privateWrite(path, text) {
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function ready(url) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      controller.signal.throwIfAborted();
    }
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error(`服务未就绪：${url}`);
}
try {
  await mkdir(state, { recursive: true, mode: 0o700 });
  let access;
  try {
    access = JSON.parse(await readFile(accessPath, "utf8"));
    if (access.environment !== "clouddrive-docker-ui-test-v1")
      throw new Error("环境标识不符，已保留既有文件");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    access = {
      environment: "clouddrive-docker-ui-test-v1",
      username: "ui-preview@clouddrive.test",
      password: randomBytes(24).toString("base64url"),
      setupToken: randomBytes(32).toString("base64url"),
    };
  }
  Object.assign(access, {
    url: origin + "/home",
    apiUrl: api,
    managementUrl: `http://127.0.0.1:${managementPort}`,
    dataDirectory: state,
  });
  await privateWrite(accessPath, JSON.stringify(access, null, 2) + "\n");
  await privateWrite(
    join(state, "backend.env"),
    `APP_IAM__LOCAL__SETUPTOKEN=${access.setupToken}\nAPP_HTTP__CORS__ALLOWEDORIGINS=${JSON.stringify([origin, api])}\n`,
  );
  await privateWrite(
    join(state, "compose.env"),
    `CLOUDDRIVE_UI_WEB_PORT=${webPort}\nCLOUDDRIVE_UI_API_PORT=${apiPort}\nCLOUDDRIVE_UI_MANAGEMENT_PORT=${managementPort}\n`,
  );
  let created = false;
  try {
    await mkdir(data, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  // Initialize only a newly created directory. Existing storage identity and permissions remain intact.
  if (created)
    await docker([
      "run",
      "--rm",
      "--user",
      "0:0",
      "--mount",
      `type=bind,source=${data},target=/data`,
      "node:24-bookworm-slim",
      "node",
      "-e",
      "const fs=require('node:fs');fs.chmodSync('/data',0o700);fs.chownSync('/data',65532,65532)",
    ]);
  if (values.build) await docker([...compose, "build", "backend", "web"]);
  await docker([...compose, "run", "--rm", "--no-deps", "migrate"]);
  await docker([...compose, "up", "-d", "backend", "web"]);
  await ready(access.managementUrl + "/readyz");
  await ready(origin + "/login");
  await ready(api + "/api/console/v1/auth/registration-policy");
  await run(process.execPath, [
    join(root, "scripts/initialize-file-preview.mjs"),
    accessPath,
  ]);
  console.log(
    `Docker 生产测试环境已就绪：${origin}/home\n账号资料：${accessPath}\n数据已保留：${data}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "部署未完成");
  process.exitCode = 1;
}
