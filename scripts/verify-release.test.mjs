import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { checkRuns, requiredAssets, verifyAssets } from "./verify-release.mjs";
const sha = "a".repeat(40),
  tag = "v0.1.0";
const runs = () => ({
  workflow_runs: ["quality.yml", "database.yml", "container.yml"].map(
    (path, id) => ({
      id,
      path: ".github/workflows/" + path,
      head_sha: sha,
      event: "push",
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/example/run/" + id,
    }),
  ),
});
test("自动发布必须等待同一提交的三个独立工作流", () => {
  assert.equal(checkRuns(runs(), sha), "success");
  const pending = runs();
  pending.workflow_runs.pop();
  assert.equal(checkRuns(pending, sha), "pending");
  assert.equal(checkRuns(runs(), "b".repeat(40)), "pending");
  const latest = runs();
  latest.workflow_runs.push({
    ...latest.workflow_runs[0],
    id: 99,
    conclusion: "failure",
  });
  assert.throws(() => checkRuns(latest, sha), /quality.yml 未通过/);
  latest.workflow_runs[3].status = "in_progress";
  assert.equal(checkRuns(latest, sha), "pending");
});
test("预发布标签不能自动提升为正式版本", () => {
  assert.throws(() => requiredAssets("v0.1.0-rc.1"), /仅正式版本/);
});

async function fixture(t, { armSha = sha } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "release-assets-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installerPath = join(directory, "source-installer");
  await writeFile(installerPath, "#!/usr/bin/env bash\necho fixture\n");
  for (const name of requiredAssets(tag)) {
    let bytes = "fixture-archive";
    if (name.endsWith(".spdx.json"))
      bytes = JSON.stringify({
        spdxVersion: "SPDX-2.3",
        packages: [{ name: "fixture" }],
      });
    if (name === "install.sh") bytes = await readFile(installerPath);
    if (name === "version.txt") bytes = tag + "\n";
    await writeFile(join(directory, name), bytes);
  }
  for (const arch of ["amd64", "arm64"]) {
    const stage = join(directory, arch);
    await mkdir(stage);
    await writeFile(join(stage, "compose.yaml"), "services: {}\n");
    await writeFile(join(stage, "images.tar"), "fixture");
    await writeFile(join(stage, "install.sh"), await readFile(installerPath));
    await writeFile(
      join(stage, "images.env"),
      `API_IMAGE=clouddrive-api:${tag}-${arch}\nWEB_IMAGE=clouddrive-web:${tag}-${arch}\n`,
    );
    await writeFile(
      join(stage, "manifest.txt"),
      `FORMAT=1\nVERSION=${tag}\nARCH=${arch}\nCOMMIT=${arch === "arm64" ? armSha : sha}\nAPI_ID=sha256:${"1".repeat(64)}\nWEB_ID=sha256:${"2".repeat(64)}\n`,
    );
    execFileSync("tar", [
      "-czf",
      join(directory, `clouddrive_${tag}_linux_${arch}_docker.tar.gz`),
      "-C",
      stage,
      "compose.yaml",
      "images.env",
      "images.tar",
      "install.sh",
      "manifest.txt",
    ]);
  }
  const lines = [];
  for (const name of requiredAssets(tag))
    if (!["checksums.txt", "checksums.txt.sigstore.json"].includes(name))
      lines.push(
        createHash("sha256")
          .update(await readFile(join(directory, name)))
          .digest("hex") +
          "  " +
          name,
      );
  await writeFile(join(directory, "checksums.txt"), lines.join("\n") + "\n");
  const release = { tag_name: tag, draft: true, prerelease: false, assets: [] };
  for (const name of requiredAssets(tag))
    release.assets.push({
      name,
      size: (await stat(join(directory, name))).size,
      state: "uploaded",
    });
  return { release, directory, tag, sha, installerPath };
}
test("完整双架构产物及其清单可通过验收", async (t) =>
  verifyAssets(await fixture(t)));
for (const missing of [
  "checksums.txt.sigstore.json",
  `clouddrive_${tag}_linux_arm64_docker.tar.gz`,
]) {
  test("缺少必要附件必须阻止发布：" + missing, async (t) => {
    const f = await fixture(t);
    f.release.assets = f.release.assets.filter((a) => a.name !== missing);
    await assert.rejects(verifyAssets(f), /缺少附件/);
  });
}
test("摘要损坏和未纳入签名清单的 SBOM 均阻止发布", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.directory, "install.sh"),
    "x".repeat(f.release.assets.find((a) => a.name === "install.sh").size),
  );
  await assert.rejects(verifyAssets(f), /摘要不符/);
  const g = await fixture(t);
  const checksumsPath = join(g.directory, "checksums.txt");
  await writeFile(
    checksumsPath,
    (await readFile(checksumsPath, "utf8"))
      .split("\n")
      .filter((x) => !x.endsWith("clouddrive-api_v0.1.0_arm64.spdx.json"))
      .join("\n"),
  );
  g.release.assets.find((a) => a.name === "checksums.txt").size = (
    await stat(checksumsPath)
  ).size;
  await assert.rejects(verifyAssets(g), /未受校验清单保护/);
});
test("即使摘要正确，另一提交的镜像包仍不能发布", async (t) => {
  const f = await fixture(t, { armSha: "b".repeat(40) });
  await assert.rejects(verifyAssets(f), /配套镜像身份不符/);
});
