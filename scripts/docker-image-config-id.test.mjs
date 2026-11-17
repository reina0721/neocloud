import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { imageConfigId } from "./docker-image-config-id.mjs";

async function fixture(
  t,
  { oci = false, corrupt = false, duplicate = false } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "image-config-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = JSON.stringify({
    os: "linux",
    architecture: "amd64",
    rootfs: { type: "layers", diff_ids: [] },
  });
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path = oci ? "blobs/sha256/" + hash : hash + ".json";
  await mkdir(join(root, "blobs/sha256"), { recursive: true });
  await writeFile(join(root, path), corrupt ? bytes + " " : bytes);
  const entry = {
    Config: path,
    RepoTags: ["clouddrive-api:v1.0.0-amd64"],
    Layers: [],
  };
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify(duplicate ? [entry, entry] : [entry]),
  );
  const archive = join(root, "images.tar");
  execFileSync("tar", ["-cf", archive, "-C", root, "manifest.json", path]);
  return { archive, id: "sha256:" + hash };
}

for (const oci of [false, true]) {
  test(`读取 ${oci ? "OCI" : "传统 Docker"} 配置的稳定内容摘要`, async (t) => {
    const f = await fixture(t, { oci });
    assert.equal(
      imageConfigId(f.archive, "clouddrive-api:v1.0.0-amd64", "amd64"),
      f.id,
    );
  });
}
test("配置内容损坏、平台错误、引用缺失或重复均失败", async (t) => {
  const bad = await fixture(t, { corrupt: true });
  assert.throws(
    () => imageConfigId(bad.archive, "clouddrive-api:v1.0.0-amd64", "amd64"),
    /摘要不符/,
  );
  const valid = await fixture(t);
  assert.throws(
    () => imageConfigId(valid.archive, "clouddrive-api:v1.0.0-amd64", "arm64"),
    /唯一/,
  );
  assert.throws(
    () => imageConfigId(valid.archive, "missing:v1", "amd64"),
    /唯一/,
  );
  const repeated = await fixture(t, { duplicate: true });
  assert.throws(
    () =>
      imageConfigId(repeated.archive, "clouddrive-api:v1.0.0-amd64", "amd64"),
    /唯一/,
  );
});
