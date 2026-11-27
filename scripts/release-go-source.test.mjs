import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareLegacyGoSource, releaseFamily } from "./release-go-source.mjs";

test("桥接构建使用隔离源码、旧 Go module 和旧命令入口", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "neocloud-release-profile-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const source = join(fixture, "source");
  const legacy = join(fixture, "legacy");
  for (const path of ["cmd/neocloud-host", "cmd/neocloud-maintenance", "internal", "pkg"])
    await mkdir(join(source, path), { recursive: true });
  const mod = "module github.com/reina0721/neocloud\n";
  await writeFile(join(source, "go.mod"), mod);
  for (const file of ["go.sum", "LICENSE", "NOTICE"]) await writeFile(join(source, file), "");
  const body = 'package main\n\nimport "github.com/reina0721/neocloud/internal/deployment"\n';
  await writeFile(join(source, "cmd/neocloud-host/main.go"), body);
  await writeFile(join(source, "internal/schema.sql"), "literal github.com/reina0721/neocloud/path");

  await prepareLegacyGoSource(source, legacy);
  assert.equal(releaseFamily("legacy"), "clouddrive");
  assert.equal(releaseFamily("neocloud"), "neocloud");
  assert.throws(() => releaseFamily("renamed"));
  assert.deepEqual((await readdir(join(legacy, "cmd"))).sort(), ["clouddrive-host", "clouddrive-maintenance"]);
  assert.equal(await readFile(join(legacy, "go.mod"), "utf8"), mod.replace("neocloud", "clouddrive"));
  assert.equal(await readFile(join(legacy, "cmd/clouddrive-host/main.go"), "utf8"), body.replace("neocloud", "clouddrive"));
  assert.equal(await readFile(join(legacy, "internal/schema.sql"), "utf8"), "literal github.com/reina0721/neocloud/path");
  assert.equal(await readFile(join(source, "cmd/neocloud-host/main.go"), "utf8"), body);
  await assert.rejects(prepareLegacyGoSource(source, legacy), /须为空/);
});
