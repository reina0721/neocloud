import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const devScript = fileURLToPath(new URL("./dev.mjs", import.meta.url));

function cli(args, { script = devScript, env } = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (value) => {
    output += value;
  });
  child.stderr.on("data", (value) => {
    output += value;
  });
  return once(child, "close").then(([code]) => ({ code, output }));
}

test("启动前拒绝无效或重复端口", async () => {
  for (const args of [
    ["--web-port", "0"],
    ["--web-port", "65536"],
    ["--web-port", "4173", "--api-port", "4173"],
    ["--unknown"],
  ])
    assert.notEqual((await cli(args)).code, 0);
});

test("端口冲突不终止占用者，也不启动 Go 或迁移", async () => {
  let requests = 0;
  const server = createServer((socket) => {
    requests += 1;
    socket.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address().port;
    const result = await cli(["--web-port", String(port)]);
    assert.equal(result.code, 1);
    assert.match(result.output, /已被占用/);
    assert.doesNotMatch(result.output, /go version|migration operation/);
    assert.equal(server.listening, true);
    assert.equal(requests, 0);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("已有 node_modules 也先按锁文件同步，安装失败不启动后端", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "clouddrive dev "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frontend = join(root, "frontend");
  const bin = join(root, "bin");
  const script = join(root, "scripts", "dev.mjs");
  await mkdir(join(frontend, "node_modules"), { recursive: true });
  await mkdir(join(root, "scripts"));
  await mkdir(bin);
  await copyFile(devScript, script);
  const windows = process.platform === "win32";
  await writeFile(
    join(bin, windows ? "npx.cmd" : "npx"),
    windows
      ? "@echo off\r\ncd\r\necho %*\r\nexit /b 42\r\n"
      : '#!/bin/sh\npwd\nprintf "%s\\n" "$*"\nexit 42\n',
    { mode: 0o700 },
  );
  const env = { ...process.env };
  const pathKey =
    Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = [bin, env[pathKey]].join(delimiter);
  const servers = Array.from({ length: 3 }, () => createServer());
  await Promise.all(
    servers.map((server) => once(server.listen(0, "127.0.0.1"), "listening")),
  );
  const [web, api, management] = servers.map((server) =>
    String(server.address().port),
  );
  await Promise.all(
    servers.map((server) => new Promise((done) => server.close(done))),
  );
  const result = await cli(
    ["--web-port", web, "--api-port", api, "--management-port", management],
    { script, env },
  );
  assert.equal(result.code, 1);
  assert.ok(result.output.includes(frontend), result.output);
  assert.match(
    result.output,
    /--yes pnpm@10\.22\.0 install --frozen-lockfile --prefer-offline --prod=false/,
  );
  assert.match(result.output, /pnpm install 退出 \(42\)/);
  assert.equal(existsSync(join(root, ".tools")), false);
  assert.equal(existsSync(join(root, ".data", "dev", "run.lock")), false);
});

test("帮助不启动任何服务", async () => {
  const result = await cli(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.output, /--preview/);
  assert.match(result.output, /Ctrl\+C/);
});
