#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { devSetupMessage } from "./dev-setup-status.mjs";

// SQLite、配置与日志的默认权限统一由启动 owner 收紧。
process.umask(0o077);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    preview: { type: "boolean", default: false },
    "legacy-preview": { type: "boolean", default: false },
    acceptance: { type: "boolean", default: false },
    prepare: { type: "boolean", default: false },
    webpack: { type: "boolean", default: false },
    "web-port": { type: "string" },
    "api-port": { type: "string" },
    "management-port": { type: "string" },
    "go-executable": { type: "string", default: "go" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "node scripts/dev.mjs [--preview | --acceptance] [--webpack] [--web-port N] [--api-port N] [--management-port N] [--go-executable PATH]\n启动前按锁文件同步前端依赖，兼容旧参数 --prepare。Ctrl+C 关闭拥有的进程树。\n--preview 保留预览数据并初始化测试账号。--acceptance 使用全新数据库运行真实浏览器验收。",
  );
  process.exit(0);
}
if (Number(process.versions.node.split(".")[0]) < 24)
  throw new Error("启动工具需要 Node 24 或更高版本。");
if (values.preview && values.acceptance)
  throw new Error("预览与一次性验收只能选择一个。");
if (values["legacy-preview"] && !values.preview)
  throw new Error("--legacy-preview 需要同时指定 --preview。");
const isolated = values.preview || values.acceptance;
const port = (value, fallback) => {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1024 || number > 65535)
    throw new Error("端口须为 1024–65535 的整数。");
  return number;
};
const webPort = port(values["web-port"], values.acceptance ? 4185 : 4180);
const apiPort = port(values["api-port"], values.acceptance ? 8088 : values.preview ? 8120 : 8080);
const managementPort = port(
  values["management-port"],
  values.acceptance ? 9098 : values.preview ? 9120 : 9090,
);
if (new Set([webPort, apiPort, managementPort]).size !== 3)
  throw new Error("三个服务必须使用不同端口。");
const acceptanceRoot = join(repo, ".data", "acceptance");
let data = values.acceptance ? acceptanceRoot : join(repo, ".data", values["legacy-preview"] ? "file-preview" : values.preview ? "preview" : "dev");
const base = `http://127.0.0.1:${webPort}`;
function brandedEnvironment(name) {
  const canonical = process.env["NEOCLOUD_" + name];
  const legacy = process.env["CLOUDDRIVE_" + name];
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy)
    throw new Error("NEOCLOUD_" + name + " 与 CLOUDDRIVE_" + name + " 的值冲突。");
  return canonical ?? legacy;
}
const viewerOrigins = JSON.parse(brandedEnvironment("ALLOWED_ORIGINS") ?? "[]");
if (
  !Array.isArray(viewerOrigins) ||
  !viewerOrigins.every((value) => {
    if (typeof value !== "string") return false;
    try {
      const origin = new URL(value);
      return ["http:", "https:"].includes(origin.protocol) && origin.origin === value;
    } catch {
      return false;
    }
  })
)
  throw new Error("NEOCLOUD_ALLOWED_ORIGINS 须为精确 HTTP(S) Origin 的 JSON 数组。");
const allowedOrigins = JSON.stringify([...new Set([base, ...viewerOrigins])]);

const backend = `http://127.0.0.1:${apiPort}`;
const children = new Set();
const logFiles = [];
const controller = new AbortController();
let stopping = false;
let failure;
let environmentLock;

function run(command, args, options = {}) {
  controller.signal.throwIfAborted();
  const label = options.label ?? command;
  const child = spawn(command, args, {
    cwd: options.cwd ?? repo,
    env: { ...(options.baseEnv ?? process.env), ...options.env },
    stdio: options.stdio ?? "inherit",
    detached: process.platform !== "win32",
    shell: false,
  });
  const result = new Promise((resolveResult, reject) => {
    child.once("error", (error) => {
      reject(new Error(`${label} 启动失败：${error.message}`, { cause: error }));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolveResult();
      else reject(new Error(`${label} 退出 (${signal ?? code})`));
    });
  });
  const record = { child, result };
  children.add(record);
  // 立即安装 rejection handler，后台服务退出不能变成未处理的 Promise。
  result.then(
    () => {
      if (!options.service) children.delete(record);
      if (options.service && !stopping)
        fail(new Error("开发服务提前退出，请检查日志。"));
    },
    (error) => {
      if (!options.service) children.delete(record);
      if (!stopping) fail(error);
    },
  );
  // 保留进程组记录到统一清理结束：根进程退出后仍可能有派生进程。
  return result;
}
function pnpm(args, env) {
  const npmArgs = ["--yes", "pnpm@10.22.0", ...args];
  const options = { cwd: join(repo, "frontend"), label: `pnpm ${args[0]}`, env };
  if (process.platform === "win32") {
    // 参数均由本工具生成；不用 shell 解释目录或配置值。
    return run(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "npx.cmd " + npmArgs.join(" ")],
      options,
    );
  }
  return run("npx", npmArgs, options);
}
function fail(error) {
  failure ??= error;
  controller.abort(error);
}
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
async function stop() {
  stopping = true;
  for (const { child } of children) {
    if (!child.pid) continue;
    if (process.platform === "win32") {
      // Windows 没有 POSIX process group，taskkill 只操作本工具拥有的树。
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((done) => {
          const killer = spawn(
            "taskkill.exe",
            ["/PID", String(child.pid), "/T", "/F"],
            { stdio: "ignore" },
          );
          killer.once("error", done);
          killer.once("exit", done);
        });
      }
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  const forced = setTimeout(() => {
    if (process.platform === "win32") return;
    for (const { child } of children) {
      if (!child.pid) continue;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") console.error(error.message);
      }
    }
  }, 8_000);
  try {
    await Promise.allSettled([...children].map(({ result }) => result));
  } finally {
    clearTimeout(forced);
    await Promise.all(logFiles.map((file) => file.close()));
    if (environmentLock) {
      await environmentLock.close();
      await unlink(join(data, "run.lock"));
    }
  }
}
async function freePort(number) {
  await new Promise((done, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(new Error(`端口 ${number} 已被占用；不会终止其进程。`)),
    );
    server.listen(number, "127.0.0.1", () => server.close(done));
  });
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function privateWrite(path, content) {
  await writeFile(path, content, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}
async function ready(url, service = "backend") {
  const deadline = Date.now() + 120_000;
  let lastStatus;
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(5_000),
        ]),
      });
      lastStatus = response.status;
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      controller.signal.throwIfAborted();
    }
    await new Promise((done) => {
      const timer = setTimeout(done, 250);
      controller.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          done();
        },
        { once: true, signal: AbortSignal.timeout(300) },
      );
    });
  }
  const status = lastStatus ? `（最近收到 HTTP ${lastStatus}）` : "";
  throw new Error(
    `启动超时：${url}${status}。日志：${join(data, `${service}.log`)}`,
  );
}
async function launch(name, command, args, options = {}) {
  const file = await open(join(data, `${name}.log`), "a", 0o600);
  logFiles.push(file);
  return {
    started: run(command, args, {
      ...options,
      service: true,
      stdio: ["ignore", file.fd, file.fd],
    }),
  };
}

try {
  for (const number of [webPort, apiPort, managementPort])
    await freePort(number);
  await mkdir(data, { recursive: true, mode: 0o700 });
  if (values.acceptance) data = await mkdtemp(join(acceptanceRoot, "run-"));
  const workdir = isolated ? data : repo;
  const binary = join(
    values.acceptance ? data : join(repo, ".tools"),
    `neocloud-${values.acceptance ? "acceptance" : values["legacy-preview"] ? "file-preview" : values.preview ? "preview" : "dev"}${process.platform === "win32" ? ".exe" : ""}`,
  );
  if (process.platform !== "win32") {
    await chmod(join(repo, ".data"), 0o700);
    await chmod(data, 0o700);
  }
  try {
    environmentLock = await open(join(data, "run.lock"), "wx", 0o600);
    await environmentLock.writeFile(String(process.pid) + "\n");
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `环境已被占用：${data}/run.lock。异常退出后，请先确认原进程已停止再删除锁文件。`,
      );
    throw error;
  }
  console.log("同步前端工作区依赖…");
  await pnpm([
    "install",
    "--frozen-lockfile",
    "--prefer-offline",
    "--prod=false",
  ]);
  await mkdir(join(repo, ".tools"), { recursive: true });
  const go = values["go-executable"];
  await run(go, ["version"]);
  await run(go, ["build", "-o", binary, "./cmd/app"]);
  const legacyToken = join(repo, ".data", "dev-setup-token");
  const tokenPath = !isolated && await exists(legacyToken) && !(await exists(join(data, "setup-token")))
    ? legacyToken : join(data, "setup-token");
  const providedSetupToken =
    !isolated && process.env.APP_IAM__LOCAL__SETUPTOKEN;
  if (!providedSetupToken && !(await exists(tokenPath)))
    await privateWrite(tokenPath, randomBytes(32).toString("base64url") + "\n");
  let setupToken =
    providedSetupToken || (await readFile(tokenPath, "utf8")).trim();
  const tokenSource = providedSetupToken
    ? "环境变量 APP_IAM__LOCAL__SETUPTOKEN"
    : tokenPath;
  const environment = {
    // 预览不能继承调用者的数据库、Storage 或认证配置而连接到真实数据。
    APP_IAM__LOCAL__SETUPTOKEN: setupToken,
    APP_HTTP__ADDR: `127.0.0.1:${apiPort}`,
    APP_MANAGEMENT__ADDR: `127.0.0.1:${managementPort}`,
    APP_HTTP__CORS__ALLOWEDORIGINS: allowedOrigins,
  };
  const backendOptions = {
    cwd: workdir,
    env: environment,
    baseEnv: isolated ? Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:neocloud_)?app_/i.test(name))) : process.env,
  };
  const configPath = join(workdir, "config.yaml");
  let accessPath;
  if (values.preview) {
    accessPath = values["legacy-preview"] ? join(repo, ".data", "preview-access.json") : join(data, "access.json");
    let preview;
    if (await exists(accessPath)) {
      preview = JSON.parse(await readFile(accessPath, "utf8"));
      const legacy = values["legacy-preview"] && preview.environment === undefined &&
        typeof preview.username === "string" && typeof preview.setupToken === "string" &&
        typeof preview.dataDirectory === "string" && resolve(preview.dataDirectory) === data;
      if ((!legacy && !["clouddrive-node-preview-v1", "neocloud-node-preview-v1"].includes(preview.environment)) || typeof preview.password !== "string")
        throw new Error("预览目录不是本工具创建的环境，已保留其内容。");
      if (legacy) {
        setupToken = preview.setupToken;
        environment.APP_IAM__LOCAL__SETUPTOKEN = setupToken;
        await privateWrite(tokenPath, setupToken + "\n");
      }
    } else {
      if (await exists(configPath))
        throw new Error("预览目录已有配置，已保留其内容。");
      preview = {
        environment: "clouddrive-node-preview-v1",
        username: "preview@neocloud.test",
        password: randomBytes(24).toString("base64url"),
      };
    }
    Object.assign(preview, {
      environment: "clouddrive-node-preview-v1",
      url: base + "/home",
      apiUrl: backend,
      managementUrl: `http://127.0.0.1:${managementPort}`,
      setupToken,
      dataDirectory: data,
    });
    await privateWrite(accessPath, JSON.stringify(preview, null, 2) + "\n");
  }
  if (isolated && !(await exists(configPath))) {
    await privateWrite(configPath, `logger:\n  environment: development\n  level: info\ndatabase:\n  driver: sqlite\n  dsn: app.db\nauth:\n  mode: session\nhttp:\n  addr: 127.0.0.1:${apiPort}\nmanagement:\n  addr: 127.0.0.1:${managementPort}\nstorage:\n  driver: local\n  local:\n    basePath: storage\nfiles:\n  transfers:\n    stagingPath: transfers\n`);
  } else if (!isolated && !(await exists(configPath))) {
    await run(binary, ["config", "init"]);
  }
  if (values.acceptance) {
    environment.APP_CONSOLE__RELAY__ALLOWEDORIGINS = JSON.stringify([backend]);
    // 在隔离实例用少量文件覆盖搜索超限，保留正常目录和回收站操作。
    environment.APP_FILES__SEARCH__TREEENTRIES = "12";
  }
  await run(binary, ["db", "migrate", "up"], backendOptions);
  if (values.acceptance)
    await run(binary, ["iam", "password-policy", "show"], { cwd: workdir, baseEnv: backendOptions.baseEnv });
  await launch("backend", binary, [], backendOptions);
  await ready(`http://127.0.0.1:${managementPort}/readyz`);
  await ready(backend + "/api/console/v1/auth/registration-policy");
  await pnpm(["codegen:plugins"]);
  // 前端使用同一 Node 生命周期，生成器与 HMR 仍由既有 frontend dev 入口拥有。
  await launch(
    "frontend",
    process.execPath,
    [join(repo, "frontend/tooling/plugin-codegen/dev.mjs")],
    {
      cwd: join(repo, "frontend"),
      env: {
        NEXT_PUBLIC_AUTH_MODE: "backend",
        NEXT_PUBLIC_AUTH_API_BASE_URL: "/api/console/v1",
        WEB_DEPLOYMENT_MODE: "server",
        WEB_HOST: "127.0.0.1",
        WEB_PORT: String(webPort),
        NEOCLOUD_BACKEND_URL: backend,
        NEOCLOUD_ALLOWED_ORIGINS: allowedOrigins,
        NEXT_DIST_DIR: values.acceptance ? `.next/acceptance-${webPort}` : values["legacy-preview"] ? ".next/file-preview" : values.preview ? ".next/preview" : ".next",
        ...(values.webpack
          ? { NEOCLOUD_DEV_BUNDLER: "webpack", WATCHPACK_POLLING: "true" }
          : {}),
      },
    },
  );
  await ready(base + "/login", "frontend");
  await ready(base + "/api/console/v1/auth/registration-policy", "frontend");
  if (values.acceptance) {
    console.log(`验收日志与数据：${data}`);
    await pnpm(["exec", "playwright", "test", "--config", "playwright.integration.config.ts"], {
      CLOUDDRIVE_TEST_WEB_URL: base,
      CLOUDDRIVE_TEST_API_URL: backend,
      CLOUDDRIVE_TEST_SETUP_TOKEN: setupToken,
      CLOUDDRIVE_TEST_PASSWORD: randomBytes(24).toString("base64url"),
    });
  } else {
    if (accessPath)
      await run(process.execPath, [
        join(repo, "scripts/initialize-file-preview.mjs"),
        accessPath,
      ]);
    const entry = accessPath
      ? `预览：${base}/home\n测试账号：${accessPath}`
      : await devSetupMessage(base, tokenSource, controller.signal);
    console.log(`${entry}\n日志：${data}\nCtrl+C 关闭服务，数据保留。`);
    if (!controller.signal.aborted)
      await new Promise((done) =>
        controller.signal.addEventListener("abort", done, { once: true }),
      );
  }
} catch (error) {
  if (!controller.signal.aborted) failure = error;
} finally {
  await stop();
}
if (failure) {
  console.error(`启动失败：${failure.message}\n服务日志目录：${data}`);
  process.exitCode = 1;
}
