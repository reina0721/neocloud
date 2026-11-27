import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function releaseFamily(profile = process.env.NEOCLOUD_RELEASE_PROFILE || "neocloud") {
  assert.ok(["neocloud", "legacy"].includes(profile), "发布 profile 必须为 neocloud 或 legacy");
  return profile === "legacy" ? "clouddrive" : "neocloud";
}

export async function prepareLegacyGoSource(root, output) {
  await mkdir(output, { recursive: true });
  assert.equal((await readdir(output)).length, 0, "兼容 Go 构建目录必须为空");
  const files = ["cmd", "internal", "pkg", "go.mod", "go.sum", "LICENSE", "NOTICE"];
  for (const file of files)
    await cp(join(root, file), join(output, file), { recursive: true, errorOnExist: true, force: false });
  const mod = join(output, "go.mod");
  const original = await readFile(mod, "utf8");
  assert.match(original, /^module github\.com\/reina0721\/neocloud\r?$/m);
  await writeFile(mod, original.replace("module github.com/reina0721/neocloud", "module github.com/reina0721/clouddrive"));

  async function rewriteGoImports(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await rewriteGoImports(path);
      } else if (entry.isFile() && entry.name.endsWith(".go")) {
        const content = await readFile(path, "utf8");
        const rewrites = content.replaceAll('"github.com/reina0721/neocloud/', '"github.com/reina0721/clouddrive/');
        if (rewrites !== content) await writeFile(path, rewrites);
      }
    }
  }
  for (const folder of ["cmd", "internal", "pkg"])
    await rewriteGoImports(join(output, folder));
  for (const command of ["host", "maintenance"])
    await rename(join(output, "cmd", `neocloud-${command}`), join(output, "cmd", `clouddrive-${command}`));
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, output, ...extra] = process.argv.slice(2);
  if (command === "family" && output === undefined) {
    console.log(releaseFamily());
  } else {
    assert.ok(command === "prepare-legacy" && output && extra.length === 0, "需要 family 或 prepare-legacy 目标目录");
    await prepareLegacyGoSource(resolve(import.meta.dirname, ".."), resolve(output));
  }
}
