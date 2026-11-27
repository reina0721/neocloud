#!/usr/bin/env node
// 仅启动脚本拥有的 Compose project 和 systemd 服务。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout } from "node:timers/promises";
import { chromium } from "../frontend/node_modules/@playwright/test/index.mjs";

const { values } = parseArgs({
  options: {
    candidate: { type: "string" },
    version: { type: "string" },
    baseline: { type: "string" },
    "baseline-version": { type: "string" },
    tool: { type: "string" },
    "legacy-candidate": { type: "boolean", default: false },
  },
});
assert.equal(process.getuid(), 0, "需要宿主机 systemd 管理权限");
assert.ok(values.candidate && values.version);
assert.equal(Boolean(values.baseline), Boolean(values["baseline-version"]));
assert.ok(
  !values["legacy-candidate"] || (values.tool && values.baseline),
  "旧版候选仅用于本地跨版验证",
);
const candidate = resolve(values.candidate);
const version = values.version;
const baseline = values.baseline && resolve(values.baseline);
const baselineVersion = values["baseline-version"] ?? version;
const trustDir = process.env.NEOCLOUD_OFFLINE_TRUST_DIR ?? process.env.CLOUDDRIVE_OFFLINE_TRUST_DIR;
assert.ok(trustDir, "需要独立提供 NEOCLOUD_OFFLINE_TRUST_DIR");
const cosign = process.env.NEOCLOUD_COSIGN ?? process.env.CLOUDDRIVE_COSIGN ?? "cosign";
const arch = process.arch === "x64" ? "amd64" : process.arch;
assert.match(arch, /^(amd64|arm64)$/);
let tool = values.tool;
async function dockerArchiveFamily(directory, tag) {
  const checksums = (await readFile(join(directory, "checksums.txt"), "utf8")).split(/\r?\n/);
  const names = ["neocloud", "clouddrive"].map((family) => `${family}_${tag}_linux_${arch}_docker.tar.gz`);
  const matching = checksums.map((line) => line.trim().split(/\s+/)[1]?.replace(/^\*/, "")).filter((name) => names.includes(name));
  assert.equal(matching.length, 1, "镜像归档必须对应唯一发布命名系列");
  return matching[0].split("_")[0];
}
if (!tool) tool = join(candidate, `${await dockerArchiveFamily(candidate, version)}-maintenance_${version}_linux_${arch}`);
tool = resolve(tool);
const sandbox = await mkdtemp(join(tmpdir(), "clouddrive-maintenance-test-"));
const root = join(sandbox, "instance");
const ctrl = join(root, ".control", "maintenance");
const socket = createServer();
await new Promise((done, fail) =>
  socket.once("error", fail).listen(0, "127.0.0.1", done),
);
const port = socket.address().port;
await new Promise((done) => socket.close(done));
const origin = `http://127.0.0.1:${port}`;
let project;
let browser;
let workerOverride;

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 8 * 60 * 1000,
    maxBuffer: 4 << 20,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}

function airgap(command, args) {
  return run("unshare", ["--net", "--", command, ...args]);
}

const imageRefs = (tag, family) =>
  ["api", "web"].map((part) => `${family}-${part}:${tag}-${arch}`);

function baselineImageExists(ref) {
  const result = spawnSync("docker", ["image", "inspect", ref], {
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.status === 0) return true;
  assert.match(result.stderr ?? "", /no such image|no such object/i);
  return false;
}

function removeFixtureImages(refs) {
  for (const ref of refs) {
    const users = run("docker", [
      "ps",
      "--all",
      "--filter",
      `ancestor=${ref}`,
      "--format",
      "{{.Names}}",
    ]);
    assert.equal(users, "", `旧镜像仍被容器使用：${ref}`);
  }
  run("docker", ["image", "rm", ...refs]);
  assert.ok(refs.every((ref) => !baselineImageExists(ref)));
}

async function isolateWorker() {
  const unit = project + "-maintenance.service";
  const directory = join("/run/systemd/system", unit + ".d");
  await mkdir(directory, { mode: 0o755 });
  workerOverride = join(directory, "90-clouddrive-offline-test.conf");
  // Docker 和网关通过路径 Unix Socket 通信。就绪检查在容器内执行。
  await writeFile(workerOverride, "[Service]\nPrivateNetwork=yes\n", {
    flag: "wx",
    mode: 0o644,
  });
  run("systemctl", ["daemon-reload"]);
  run("systemctl", ["restart", unit]);
  const pid = run("systemctl", ["show", unit, "--property=MainPID", "--value"]);
  assert.match(pid, /^[1-9]\d*$/);
  assert.notEqual(
    await readlink(`/proc/${pid}/ns/net`),
    await readlink("/proc/self/ns/net"),
    "维护进程没有进入独立网络命名空间",
  );
  const ns = (...args) =>
    run("nsenter", ["--target", pid, "--net", "--", ...args]);
  assert.match(ns("ip", "-o", "link", "show"), /^\d+: lo: [^\n]+$/);
  assert.equal(ns("ip", "route", "show", "default"), "");
  assert.equal(ns("ip", "-6", "route", "show", "default"), "");
  await wait(async () => {
    const response = await fetch(origin + "/login", {
      headers: { Connection: "close" },
      signal: AbortSignal.timeout(15000),
    });
    return response.ok;
  }, "断网维护进程、Docker Unix Socket 与原站点恢复就绪");
}

const read = async (path) => (await readFile(path, "utf8")).trim();
const cookies = new Map();
let csrf;
async function api(path, method = "GET", body, status = 200) {
  const res = await fetch(origin + "/api/console/v1" + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Connection: "close",
      Origin: origin,
      Cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; "),
      "X-CSRF-Token": csrf ?? "",
      "Content-Type": "application/json",
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  for (const cookie of res.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    const at = pair.indexOf("=");
    cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
  assert.equal(res.status, status, `${method} ${path}`);
  return path.endsWith("/content") ? res.text() : res.json();
}

async function wait(test, description, limit = 240000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const result = await test();
    if (result) return result;
    await setTimeout(250);
  }
  throw new Error("等待超时：" + description);
}

async function restorePoint(page, id) {
  const details = page.locator("details").filter({ hasText: id });
  await details.locator("summary").click();
  await details.getByLabel("输入恢复点编号确认").fill(id);
  await details.getByRole("button", { name: "恢复此备份" }).click();
}

async function finishedJob(id, action) {
  return wait(async () => {
    const journal = JSON.parse(await read(join(ctrl, "state.json")));
    const matches = journal.jobs.filter((job) => job.id === id);
    assert.ok(matches.length <= 1, "同一编号只能有一个持久化维护任务");
    const job = matches[0];
    return job?.action === action && job.finished ? job : null;
  }, `维护任务完成：${action}`);
}

try {
  const initialBundle = baseline ?? candidate;
  const installer = join(initialBundle, "install.sh");
  const previousRefs = baseline ? imageRefs(baselineVersion, await dockerArchiveFamily(baseline, baselineVersion)) : [];
  const ownsPreviousImages =
    baseline && previousRefs.every((ref) => !baselineImageExists(ref));
  if (baseline) {
    airgap(tool, [
      "verify-release",
      "--release-dir",
      baseline,
      "--version",
      baselineVersion,
      "--trust-dir",
      trustDir,
      "--asset",
      "install.sh",
    ]);
  }
  airgap("bash", [
    installer,
    "install",
    "--dir",
    root,
    "--port",
    String(port),
    ...(baselineVersion === "v0.1.2"
      ? []
      : ["--bind", "127.0.0.1", "--public-url", origin, "--allow-http"]),
    "--release-dir",
    initialBundle,
    ...(baseline ? [] : ["--trust-dir", trustDir]),
    "--version",
    baselineVersion,
  ]);
  project = await read(join(root, ".control", "project"));
  assert.match(project, /^(neocloud|clouddrive)-[0-9a-f]{12}$/);
  const imageID = (ref) =>
    run("docker", ["image", "inspect", "--format", "{{.Id}}", ref]);
  const previousImageIDs = previousRefs.map(imageID);
  const account = {
    email: "maintenance-owner@clouddrive.test",
    password: randomBytes(24).toString("base64url"),
  };
  csrf = (await api("/auth/csrf")).token;
  await api("/auth/setup", "POST", {
    ...account,
    name: "维护验收",
    setupToken: await read(join(root, ".control", "setup-token")),
  });
  await api("/auth/login", "POST", account);
  csrf = (await api("/auth/csrf")).token;
  const content = "维护前的文件内容\n" + randomUUID();
  const folder = await api("/native/files/folders", "POST", {
    name: "运维验收",
    parentId: "",
  });
  const sample = await api("/native/files/text", "POST", {
    parentId: folder.id,
    name: "sample.txt",
    text: content,
    key: randomUUID(),
  });
  const share = await api("/native/files/shares", "POST", {
    rootId: sample.id,
    title: "维护验收分享",
  });
  async function verifyShare() {
    const response = await fetch(
      origin + "/api/v1/file-shares/" + share.token,
      {
        headers: { Connection: "close" },
        signal: AbortSignal.timeout(15000),
      },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).root.id, sample.id);
  }

  // 首个支持网页运维的版本以前，旧安装器和旧 API 仅作为迁移夹具。
  // 签名后的发布工具可在旧实例上接管端口，初次升级通过恢复会话提交。
  if (baseline) await cp(resolve("install.sh"), join(root, "install.sh"));
  console.log("已初始化真实实例和文件，开始交接站点端口");
  if (baseline || values.tool) {
    run(tool, ["enable", "--root", root, "--cosign", cosign]);
  } else {
    run("env", [
      "PATH=" +
        (cosign.includes("/") ? resolve(cosign, "..") + ":" : "") +
        process.env.PATH,
      "bash",
      join(root, "install.sh"),
      "enable-web-management",
      "--release-dir",
      candidate,
      "--trust-dir",
      trustDir,
    ]);
  }
  const gateway = await fetch(origin + "/maintenance", {
    method: "HEAD",
    headers: { Connection: "close" },
  });
  assert.equal(gateway.headers.get("X-CloudDrive-Maintenance"), "1");
  console.log("同址网关已启动，开始真实 Chromium 操作");
  const cfg = JSON.parse(await read(join(ctrl, "gateway.json")));
  assert.match(cfg.upstream, /^127\.0\.0\.1:\d+$/);
  assert.notEqual(cfg.upstream, `127.0.0.1:${port}`);
  await isolateWorker();

  browser = await chromium.launch({
    executablePath: process.env.CLOUDDRIVE_CHROMIUM,
    args: ["--no-sandbox"],
  });
  const owner = await browser.newContext();
  await owner.addCookies(
    [...cookies]
      .filter(([name, value]) => value && !name.startsWith("__Host-"))
      .map(([name, value]) => ({ name, value, url: origin })),
  );
  const page = await owner.newPage();
  const visitor = await browser.newPage();
  await visitor.goto(origin + "/maintenance");
  assert.equal(
    await visitor
      .getByRole("button", { name: "检查本地包", exact: true })
      .count(),
    0,
  );
  await visitor.getByLabel("恢复凭据", { exact: true }).fill("invalid");
  const rejection = visitor.waitForResponse(
    (res) => res.request().method() === "POST",
  );
  await visitor.getByRole("button", { name: "进入维护" }).click();
  const rejected = await rejection;
  assert.equal(rejected.status(), 403);
  assert.match(await rejected.text(), /恢复凭据无效/);
  const forged = await page.request.post(origin + "/maintenance", {
    headers: { Origin: "https://foreign.invalid" },
    form: { action: "backup", csrf: "invalid" },
  });
  assert.equal(forged.status(), 403);

  await page.goto(origin + "/maintenance");
  const hasOwner = async () =>
    (await page
      .getByRole("button", { name: "检查本地包", exact: true })
      .count()) > 0;
  if (baseline && !(await hasOwner())) {
    await page
      .getByLabel("恢复凭据", { exact: true })
      .fill(await read(join(ctrl, "recovery-token")));
    await page.getByRole("button", { name: "进入维护" }).click();
  }
  if (baseline) {
    assert.equal(
      await page
        .getByRole("button", { name: `从本地包升级到 ${version}`, exact: true })
        .count(),
      0,
    );
    for (const [bundle, tag] of [
      [baseline, baselineVersion],
      [candidate, version],
    ]) {
      const imported = airgap(tool, [
        "import-release",
        "--root",
        root,
        "--release-dir",
        bundle,
        "--version",
        tag,
        "--trust-dir",
        trustDir,
      ]);
      assert.equal(JSON.parse(imported).version, tag);
    }
    await page.getByRole("button", { name: "检查本地包", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: /检查本地包.*操作完成/ })
      .waitFor({ timeout: 90000 });
    const localReleases = page.locator(".local-releases");
    await localReleases.getByText(baselineVersion, { exact: true }).waitFor();
    const upgrade = localReleases.getByRole("button", {
      name: `从本地包升级到 ${version}`,
      exact: true,
    });
    await upgrade.locator("..").getByLabel("确认停服备份和升级").check();
    const [original, observed] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.method() === "POST" &&
          req.url() === origin + "/maintenance" &&
          new URLSearchParams(req.postData()).get("action") === "upgrade",
      ),
      wait(async () => {
        const res = await fetch(origin + "/dav/release-fixture/", {
          method: "PROPFIND",
          signal: AbortSignal.timeout(15000),
        });
        return res.status === 503 ? res : null;
      }, "停机期间 WebDAV 返回 503"),
      upgrade.click(),
    ]);
    assert.ok(observed.headers.get("Retry-After"));
    const fields = Object.fromEntries(new URLSearchParams(original.postData()));
    assert.equal(fields.source, "offline");
    assert.equal(fields.target, version);
    assert.equal(fields.expected, baselineVersion);
    const retry = await page.request.post(origin + "/maintenance", {
      headers: { Origin: origin },
      maxRedirects: 0,
      form: fields,
    });
    assert.equal(retry.status(), 303);
    const installed = await finishedJob(fields.id, "upgrade");
    assert.equal(installed.phase, "succeeded", installed.result);
    assert.equal(installed.offline, true);
    assert.equal(await read(join(root, ".control", "current")), version);
    await page
      .getByRole("status")
      .filter({ hasText: /本地来源.*操作完成/ })
      .waitFor({ timeout: 90000 });
    assert.equal(await api("/native/files/" + sample.id + "/content"), content);
    await verifyShare();
    // Discard recovery cookies; the new application must authorize its owner itself.
    if (!values["legacy-candidate"]) {
      await owner.clearCookies({ name: /^(neocloud|clouddrive)_maintenance_recovery$/ });
    }
  }
  if (values["legacy-candidate"]) {
    await page.goto(origin + "/maintenance");
  } else {
    const ordinary = {
      email: "maintenance-member@clouddrive.test",
      password: randomBytes(24).toString("base64url"),
    };
    const memberRole = (
      await api("/roles", "POST", { name: "维护验收普通角色", permissions: [] })
    ).role;
    await api("/users", "POST", {
      ...ordinary,
      name: "普通成员",
      status: "active",
      roleIds: [memberRole.id],
    });
    const memberCsrf = (
      await (
        await visitor.request.get(origin + "/api/console/v1/auth/csrf")
      ).json()
    ).token;
    const memberLogin = await visitor.request.post(
      origin + "/api/console/v1/auth/login",
      {
        headers: { Origin: origin, "X-CSRF-Token": memberCsrf },
        data: ordinary,
      },
    );
    assert.ok(memberLogin.ok());
    assert.equal(
      (
        await visitor.request.get(origin + "/api/console/v1/deployment/owner")
      ).status(),
      403,
    );
    await visitor.goto(origin + "/maintenance");
    assert.equal(
      await visitor
        .getByRole("button", { name: "检查本地包", exact: true })
        .count(),
      0,
    );

    await page.goto(origin + "/system-tools/runtime");
    await page
      .getByRole("link", { name: /打开维护页|Open maintenance/ })
      .click();
    assert.equal(new URL(page.url()).pathname, "/maintenance");
  }
  await page.getByRole("button", { name: "停服创建完整备份" }).waitFor();
  await page.getByRole("button", { name: "停服创建完整备份" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /操作完成/ })
    .waitFor({ timeout: 90000 });
  console.log("所有者已完成完整备份，开始验证恢复");
  const state = JSON.parse(await read(join(ctrl, "state.json")));
  const snapshot = state.backups.at(-1);
  assert.ok(snapshot?.id);
  const later = await api("/native/files/text", "POST", {
    parentId: folder.id,
    name: "later.txt",
    text: "after backup",
    key: randomUUID(),
  });
  await restorePoint(page, snapshot.id);
  await page
    .getByRole("status")
    .filter({ hasText: /操作完成/ })
    .waitFor({ timeout: 90000 });
  assert.equal(await api("/native/files/" + sample.id + "/content"), content);
  await api("/native/files/" + later.id + "/content", "GET", undefined, 404);
  if (baseline) {
    const previousData = state.backups.find(
      (backup) => backup.version === baselineVersion,
    );
    assert.ok(previousData?.id, "跨版本升级必须保留原版本的完整恢复点");
    const persistent = await api("/native/files/text", "POST", {
      parentId: folder.id,
      name: "after-upgrade.txt",
      text: "after upgrade",
      key: randomUUID(),
    });
    if (ownsPreviousImages) {
      removeFixtureImages(previousRefs);
    } else {
      console.log("旧版本镜像在验收前已存在，保留原镜像并跳过清除测试");
    }
    await page
      .getByRole("button", { name: `兼容回退到 ${baselineVersion}` })
      .click();
    const finalRollback = await wait(async () => {
      const latest = JSON.parse(await read(join(ctrl, "state.json"))).jobs.at(
        -1,
      );
      return latest?.action === "rollback" && latest.finished ? latest : null;
    }, "网页兼容回退");
    assert.equal(finalRollback.offline, true);
    const returned = await read(join(root, ".control", "current"));
    if (finalRollback.phase === "succeeded")
      assert.equal(returned, baselineVersion);
    else {
      assert.equal(returned, version);
      assert.match(finalRollback.result, /不兼容/);
    }
    assert.deepEqual(previousRefs.map(imageID), previousImageIDs);
    assert.equal(
      await api("/native/files/" + persistent.id + "/content"),
      "after upgrade",
    );
    await page.reload();
    if (!(await hasOwner())) {
      await page
        .getByLabel("恢复凭据", { exact: true })
        .fill(await read(join(ctrl, "recovery-token")));
      await page.getByRole("button", { name: "进入维护" }).click();
    }
    if (ownsPreviousImages && returned !== baselineVersion) {
      removeFixtureImages(previousRefs);
    }
    await restorePoint(page, previousData.id);
    await page
      .getByRole("status")
      .filter({ hasText: /操作完成/ })
      .waitFor({ timeout: 90000 });
    assert.equal(
      await read(join(root, ".control", "current")),
      baselineVersion,
    );
    assert.deepEqual(previousRefs.map(imageID), previousImageIDs);
    assert.equal(await api("/native/files/" + sample.id + "/content"), content);
    await verifyShare();
    await api(
      "/native/files/" + persistent.id + "/content",
      "GET",
      undefined,
      404,
    );
    if (ownsPreviousImages)
      console.log("删除测试旧镜像后，离线回退与恢复保留了原始镜像身份");
  }
  console.log(
    `原生 Docker、断网 systemd 维护进程与 Chromium 验收通过：${arch} ${baselineVersion} → ${version}`,
  );
} finally {
  await browser?.close();
  if (project) {
    const units = [
      project + "-gateway.service",
      project + "-maintenance.service",
    ];
    spawnSync("systemctl", ["disable", "--now", ...units]);
    if (workerOverride) {
      await rm(workerOverride, { force: true });
      await rmdir(dirname(workerOverride));
    }
    const active = await read(join(root, ".control", "current"));
    run("docker", [
      "compose",
      "--project-directory",
      root,
      "--env-file",
      join(root, "runtime.env"),
      "--env-file",
      join(root, "releases", active, "images.env"),
      "--project-name",
      project,
      "--file",
      join(root, "releases", active, "compose.yaml"),
      "down",
      "--remove-orphans",
    ]);
    for (const unit of units)
      await rm(join("/etc/systemd/system", unit), { force: true });
    for (const family of ["neocloud", "clouddrive"]) {
      await rm(join("/etc", family, project), { force: true, recursive: true });
      await rm(join("/usr/local/lib", family, project), { force: true, recursive: true });
    }
    spawnSync("groupdel", [project + "-gw"]);
    run("systemctl", ["daemon-reload"]);
  }
  assert.ok(sandbox.startsWith(join(tmpdir(), "clouddrive-maintenance-test-")));
  await rm(sandbox, { recursive: true, force: true });
}
