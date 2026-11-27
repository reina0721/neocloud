#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const repo = resolve(import.meta.dirname, "..");
const frontend = join(repo, "frontend");
const web = join(frontend, "apps", "web");
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    commit: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "node scripts/build-static-web.mjs --output ABSOLUTE_PATH [--commit FULL_SHA]",
  );
  process.exit(0);
}
if (Number(process.versions.node.split(".")[0]) < 24)
  throw new Error("静态 Web 构建需要 Node 24 或更高版本。");
if (!values.output || !isAbsolute(values.output))
  throw new Error("--output 必须是尚未存在的绝对路径。");
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
const buildId = values.commit ?? head;
if (!/^[a-f0-9]{40}$/.test(buildId) || buildId !== head)
  throw new Error("--commit 必须是当前检出的完整 Git 提交 ID。");

const environment = {
  ...process.env,
  NEXT_DIST_DIR: "out",
  WEB_DEPLOYMENT_MODE: "static",
  NEXT_PUBLIC_AUTH_MODE: "backend",
  NEXT_PUBLIC_AUTH_API_BASE_URL: "/api/console/v1",
  NEXT_PUBLIC_CLOUDDRIVE_WEB_BUILD_ID: buildId,
  CLOUDDRIVE_NATIVE_BUILD_CACHE: "0",
};
// Next uses .next for intermediate export files, even when distDir names the export destination.
// A private application copy keeps those files and next-env.d.ts away from running dev servers.
const scratch = join(frontend, ".next");
await mkdir(scratch, { recursive: true });
const scratchRoot = await realpath(scratch);
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
const outputRoot = await realpath(dirname(output));
const destination = join(outputRoot, basename(output));
if (await exists(destination))
  throw new Error("输出目录已存在：" + destination);

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function run(script, args, cwd) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: environment,
    stdio: "inherit",
  });
  await new Promise((success, fail) => {
    child.once("error", fail);
    child.once("exit", (code, signal) =>
      code === 0
        ? success()
        : fail(
            new Error(basename(script) + " 退出 (" + (signal ?? code) + ")"),
          ),
    );
  });
}

async function clearOwned(path, directory, prefix) {
  if (!path) return;
  if (dirname(path) !== directory || !basename(path).startsWith(prefix))
    throw new Error("临时目录超出构建范围：" + path);
  await rm(path, { recursive: true, force: true });
}

const app = await mkdtemp(join(scratchRoot, "clouddrive-static-app-"));
let publication;
let failure;
try {
  await access(join(web, "node_modules", "next", "dist", "bin", "next"));
  await run(
    join(frontend, "tooling/plugin-codegen/codegen.mjs"),
    ["--check"],
    frontend,
  );
  for (const file of [
    "package.json",
    "next.config.ts",
    "postcss.config.mjs",
    "tsconfig.json",
    "vitest.config.ts",
    "e2e",
    "runtime",
  ]) {
    await cp(join(web, file), join(app, file), { recursive: true });
  }
  await cp(join(web, "src"), join(app, "src"), {
    recursive: true,
    // The Go runtime owns these request-time routes for the independent static profile.
    filter: (source) => source !== join(web, "src", "proxy.ts"),
  });
  await cp(join(web, "public"), join(app, "public"), {
    recursive: true,
    filter: (source) => source !== join(web, "public", "file-viewers", "pdf"),
  });
  await symlink(
    join(web, "node_modules"),
    join(app, "node_modules"),
    "junction",
  );
  await run(
    join(frontend, "tooling/prepare-pdf-assets.mjs"),
    ["--public-dir", join(app, "public")],
    frontend,
  );
  await run(
    join(web, "node_modules", "next", "dist", "bin", "next"),
    ["build"],
    app,
  );

  const exported = join(app, "out");
  for (const path of [
    "index.html",
    "404.html",
    "login.html",
    "home.html",
    "workspace.html",
    "_next/static",
  ])
    await access(join(exported, path));
  const html = await readFile(join(exported, "home.html"), "utf8");
  if (!html.includes('data-dpl-id="' + buildId + '"'))
    throw new Error("Next 导出缺少与 Web 元数据相同的部署标识。");
  publication = await mkdtemp(join(outputRoot, ".clouddrive-web-"));
  await cp(exported, publication, { recursive: true });
  await writeFile(
    join(publication, "web-build.json"),
    JSON.stringify({ buildId }) + "\n",
  );
  if (await exists(destination))
    throw new Error("输出目录已存在：" + destination);
  await rename(publication, destination);
  publication = undefined;
  console.log("静态 Web 产物：" + destination);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const results = await Promise.allSettled([
    clearOwned(app, scratchRoot, "clouddrive-static-app-"),
    clearOwned(publication, outputRoot, ".clouddrive-web-"),
  ]);
  const cleanupErrors = results
    .filter((result) => result.status === "rejected")
    .map(({ reason }) => reason);
  if (cleanupErrors.length) {
    const cleanup = new AggregateError(
      cleanupErrors,
      "清理静态构建临时目录失败。",
    );
    if (failure) console.error(cleanup);
    else throw cleanup;
  }
}
