// 正式发布前的窄门禁：同提交的独立工作流、完整附件与配套镜像清单。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { verifyHeader } from "./verify-elf-platform.mjs";

const workflows = ["quality.yml", "database.yml", "container.yml"];
export function selectDraft(pages, tag) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/, "仅正式版本允许自动发布");
  assert.ok(
    Array.isArray(pages) && pages.every(Array.isArray),
    "GitHub Release 分页列表无效",
  );
  const matches = pages.flat().filter((release) => release.tag_name === tag);
  assert.equal(matches.length, 1, `必须恰好找到一个 ${tag} Release`);
  assert.equal(matches[0].draft, true, "发布前必须保持 draft");
  assert.equal(matches[0].prerelease, false, "不能发布预发布版本");
  return matches[0];
}

export function checkRuns(payload, sha) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.ok(Array.isArray(payload.workflow_runs), "工作流列表无效");
  let pending = false;
  for (const workflow of workflows) {
    const run = payload.workflow_runs
      .filter(
        (r) =>
          r.path === `.github/workflows/${workflow}` &&
          r.head_sha === sha &&
          r.head_branch === "main" &&
          r.event === "push",
      )
      .sort((a, b) => b.id - a.id)[0];
    if (!run || run.status !== "completed") pending = true;
    else
      assert.equal(
        run.conclusion,
        "success",
        `${workflow} 未通过：${run.html_url}`,
      );
  }
  return pending ? "pending" : "success";
}

export function requiredAssets(tag) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/, "仅正式版本允许自动发布");
  const version = tag.slice(1);
  const goArchives = [
    `clouddrive_${version}_linux_amd64.tar.gz`,
    `clouddrive_${version}_windows_amd64.zip`,
  ];
  const managedArchives = [["windows", "amd64"], ["linux", "amd64"], ["linux", "arm64"]].flatMap(
    ([os, arch]) => ["managed-go", "managed-full"].map(
      (profile) => `clouddrive_${tag}_${os}_${arch}_${profile}.zip`,
    ),
  );
  return [
    ...goArchives,
    ...goArchives.map((name) => name + ".spdx.json"),
    ...managedArchives,
    ...managedArchives.map((name) => name + ".spdx.json"),
    ...["amd64", "arm64"].flatMap((arch) => [
      `clouddrive_${tag}_linux_${arch}_docker.tar.gz`,
      `clouddrive-maintenance_${tag}_linux_${arch}`,
      ...["api", "web"].map(
        (kind) => `clouddrive-${kind}_${tag}_${arch}.spdx.json`,
      ),
    ]),
    "install.sh",
    "version.txt",
    "checksums.txt",
    "checksums.txt.sigstore.json",
  ];
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyAssets({
  release,
  directory,
  tag,
  sha,
  installerPath,
}) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(release.tag_name, tag);
  assert.equal(release.draft, true, "发布前必须保持 draft");
  assert.equal(release.prerelease, false);
  assert.ok(Array.isArray(release.assets));
  const assets = new Map();
  for (const asset of release.assets) {
    assert.equal(basename(asset.name), asset.name, "附件名称不安全");
    assert.ok(!assets.has(asset.name), "附件名称重复");
    assert.equal(asset.state, "uploaded");
    assert.ok(asset.size > 0);
    assert.equal(
      (await stat(join(directory, asset.name))).size,
      asset.size,
      `附件长度不符：${asset.name}`,
    );
    assets.set(asset.name, asset);
  }
  for (const name of requiredAssets(tag))
    assert.ok(assets.has(name), `缺少附件：${name}`);
  const checksums = new Map();
  const lines = (await readFile(join(directory, "checksums.txt"), "utf8"))
    .trim()
    .split(/\r?\n/);
  for (const line of lines) {
    const match = /^([a-f0-9]{64})\s+\*?([A-Za-z0-9._-]+)$/.exec(line);
    assert.ok(match, "校验清单格式无效");
    assert.ok(!checksums.has(match[2]), "校验条目重复");
    assert.ok(assets.has(match[2]), `清单引用不存在的附件：${match[2]}`);
    assert.equal(
      await digest(join(directory, match[2])),
      match[1],
      `摘要不符：${match[2]}`,
    );
    checksums.set(match[2], match[1]);
  }
  for (const name of assets.keys()) {
    if (!["checksums.txt", "checksums.txt.sigstore.json"].includes(name))
      assert.ok(checksums.has(name), `附件未受校验清单保护：${name}`);
    if (name.endsWith(".spdx.json")) {
      const sbom = JSON.parse(await readFile(join(directory, name), "utf8"));
      assert.match(sbom.spdxVersion, /^SPDX-2\.\d+$/);
      assert.ok(
        Array.isArray(sbom.packages) && sbom.packages.length > 0,
        `SBOM 为空：${name}`,
      );
    }
  }
  assert.equal(
    (await readFile(join(directory, "version.txt"), "utf8")).trim(),
    tag,
  );
  assert.deepEqual(
    await readFile(join(directory, "install.sh")),
    await readFile(installerPath),
  );
  for (const arch of ["amd64", "arm64"]) {
    const tool = await open(
      join(directory, `clouddrive-maintenance_${tag}_linux_${arch}`),
      "r",
    );
    try {
      const header = Buffer.alloc(20);
      const { bytesRead } = await tool.read(header);
      verifyHeader(header.subarray(0, bytesRead), arch);
    } finally {
      await tool.close();
    }
    const path = join(
      directory,
      `clouddrive_${tag}_linux_${arch}_docker.tar.gz`,
    );
    const names = execFileSync("tar", ["-tzf", path], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    assert.deepEqual(names, [
      "compose.yaml",
      "images.env",
      "images.tar",
      "install.sh",
      "manifest.txt",
    ]);
    const manifest = new Map();
    for (const line of execFileSync("tar", ["-xOzf", path, "manifest.txt"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")) {
      const at = line.indexOf("=");
      assert.ok(at > 0 && !manifest.has(line.slice(0, at)), "镜像清单无效");
      manifest.set(line.slice(0, at), line.slice(at + 1));
    }
    for (const [key, value] of Object.entries({
      FORMAT: "1",
      INSTANCE_LAYOUT: "1",
      OFFLINE_MAINTENANCE: "1",
      VERSION: tag,
      ARCH: arch,
      COMMIT: sha,
    }))
      assert.equal(
        manifest.get(key),
        value,
        `配套镜像身份不符：${arch}/${key}`,
      );
    for (const key of ["API_ID", "WEB_ID"])
      assert.match(manifest.get(key), /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      execFileSync("tar", ["-xOzf", path, "images.env"], { encoding: "utf8" }),
      `API_IMAGE=clouddrive-api:${tag}-${arch}\nWEB_IMAGE=clouddrive-web:${tag}-${arch}\n`,
    );
    assert.deepEqual(
      execFileSync("tar", ["-xOzf", path, "install.sh"]),
      await readFile(installerPath),
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [command, input, arg, sha] = process.argv.slice(2);
    const payload = JSON.parse(await readFile(input, "utf8"));
    if (command === "draft") {
      console.log(JSON.stringify(selectDraft(payload, arg)));
    } else if (command === "checks") {
      const state = checkRuns(payload, arg);
      console.log(`独立工作流：${state}`);
      if (state === "pending") process.exitCode = 75;
    } else {
      assert.equal(command, "assets", "命令必须为 draft、checks 或 assets");
      await verifyAssets({
        release: payload,
        directory: resolve(arg),
        tag: process.env.GITHUB_REF_NAME,
        sha,
        installerPath: resolve("install.sh"),
      });
      console.log("正式附件、校验和、SBOM 与镜像版本清单通过。");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
