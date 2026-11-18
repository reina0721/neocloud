#!/usr/bin/env node
// 仅启动脚本拥有的 Compose project 和 systemd 服务。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
const arch = process.arch === "x64" ? "amd64" : process.arch;
assert.match(arch, /^(amd64|arm64)$/);
const tool = resolve(
  values.tool ??
    join(candidate, `clouddrive-maintenance_${version}_linux_${arch}`),
);
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

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 8 * 60 * 1000,
    maxBuffer: 4 << 20,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
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

try {
  const initialBundle = baseline ?? candidate;
  const installer = join(initialBundle, "install.sh");
  run("bash", [
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
    "--version",
    baselineVersion,
  ]);
  project = await read(join(root, ".control", "project"));
  assert.match(project, /^clouddrive-[0-9a-f]{12}$/);
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
    run(tool, [
      "enable",
      "--root",
      root,
      "--cosign",
      process.env.CLOUDDRIVE_COSIGN ?? "cosign",
    ]);
  } else {
    const verifier = process.env.CLOUDDRIVE_COSIGN ?? "cosign";
    run("env", [
      "PATH=" +
        (verifier.includes("/") ? resolve(verifier, "..") + ":" : "") +
        process.env.PATH,
      "bash",
      join(root, "install.sh"),
      "enable-web-management",
      "--release-dir",
      candidate,
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
    await visitor.getByRole("button", { name: "检查正式版" }).count(),
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
    (await page.getByRole("button", { name: "检查正式版" }).count()) > 0;
  if (baseline && !(await hasOwner())) {
    await page
      .getByLabel("恢复凭据", { exact: true })
      .fill(await read(join(ctrl, "recovery-token")));
    await page.getByRole("button", { name: "进入维护" }).click();
  }
  if (baseline) {
    const assets = join(ctrl, "assets", version);
    await mkdir(assets, { recursive: true });
    for (const name of [
      "checksums.txt",
      "checksums.txt.sigstore.json",
      `clouddrive_${version}_linux_${arch}_docker.tar.gz`,
    ])
      await cp(join(candidate, name), join(assets, name));
    // 发布草稿的版本已固定。暂存同签名的附件，再从浏览器提交升级任务。
    const portState = join(ctrl, "state.json");
    await wait(
      async () => JSON.parse(await read(portState)).current === baselineVersion,
      "旧实例注册",
    );
    const csrfInput = await page
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    const request = () =>
      page.request.post(origin + "/maintenance", {
        headers: { Origin: origin },
        maxRedirects: 0,
        form: {
          action: "upgrade",
          target: version,
          expected: baselineVersion,
          id: requestID,
          csrf: csrfInput,
        },
      });
    const requestID = randomBytes(16).toString("hex");
    const responses = await Promise.all([request(), request()]);
    assert.ok(responses.every((res) => res.status() === 303));
    const observed = await wait(async () => {
      const res = await fetch(origin + "/dav/release-fixture/", {
        method: "PROPFIND",
      });
      return res.status === 503 ? res : null;
    }, "停机期间 WebDAV 返回 503");
    assert.ok(observed.headers.get("Retry-After"));
    await page.goto(origin + "/maintenance");
    await page.getByRole("heading", { name: "本次任务" }).waitFor();
    await wait(
      async () => (await read(join(root, ".control", "current"))) === version,
      "升级并提交新版本",
    );
    await page
      .getByRole("status")
      .filter({ hasText: /操作完成/ })
      .waitFor({ timeout: 90000 });
    assert.equal(await api("/native/files/" + sample.id + "/content"), content);
    await verifyShare();
    // Discard recovery cookies; the new application must authorize its owner itself.
    if (!values["legacy-candidate"]) {
      await owner.clearCookies({ name: "clouddrive_maintenance_recovery" });
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
      await visitor.getByRole("button", { name: "检查正式版" }).count(),
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
    await page
      .getByRole("button", { name: `兼容回退到 ${baselineVersion}` })
      .click();
    const finalRollback = await wait(async () => {
      const latest = JSON.parse(await read(join(ctrl, "state.json"))).jobs.at(
        -1,
      );
      return latest?.action === "rollback" && latest.finished ? latest : null;
    }, "网页兼容回退");
    const returned = await read(join(root, ".control", "current"));
    if (finalRollback.phase === "succeeded")
      assert.equal(returned, baselineVersion);
    else {
      assert.equal(returned, version);
      assert.match(finalRollback.result, /不兼容/);
    }
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
    await restorePoint(page, previousData.id);
    await page
      .getByRole("status")
      .filter({ hasText: /操作完成/ })
      .waitFor({ timeout: 90000 });
    assert.equal(
      await read(join(root, ".control", "current")),
      baselineVersion,
    );
    assert.equal(await api("/native/files/" + sample.id + "/content"), content);
    await verifyShare();
    await api(
      "/native/files/" + persistent.id + "/content",
      "GET",
      undefined,
      404,
    );
  }
  console.log(
    `原生 Docker、systemd 与 Chromium 维护验收通过：${arch} ${baselineVersion} → ${version}`,
  );
} finally {
  await browser?.close();
  if (project) {
    const units = [
      project + "-gateway.service",
      project + "-maintenance.service",
    ];
    spawnSync("systemctl", ["disable", "--now", ...units]);
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
    await rm(join("/etc/clouddrive", project), {
      force: true,
      recursive: true,
    });
    await rm(join("/usr/local/lib/clouddrive", project), {
      force: true,
      recursive: true,
    });
    spawnSync("groupdel", [project + "-gw"]);
    run("systemctl", ["daemon-reload"]);
  }
  assert.ok(sandbox.startsWith(join(tmpdir(), "clouddrive-maintenance-test-")));
  await rm(sandbox, { recursive: true, force: true });
}
