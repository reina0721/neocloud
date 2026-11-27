// GoReleaser 的 dist 不支持模板；在进程外按项目布局渲染这一处受控占位符。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const placeholder = 'dist: "{{ .Env.GORELEASER_DIST }}"';
export function renderReleaseConfig(
  source,
  directory,
  root = resolve(import.meta.dirname, ".."),
) {
  assert.ok(
    typeof directory === "string" &&
      directory.trim() &&
      !directory.includes("\n"),
    "发布目录无效",
  );
  assert.equal(
    source.split(placeholder).length,
    2,
    "必须有且仅有一个受控 dist 占位符",
  );
  // GoReleaser 的归档 glob 使用相对路径；绝对路径会被 glob 库错误拼接。
  const archiveGlob = `${relative(root, directory).split(sep).join("/")}/licenses/{{ .Os }}_{{ .Arch }}/**`;
  return source
    .replace(placeholder, "dist: " + JSON.stringify(directory))
    .replace(
      'src: "{{ .Env.GORELEASER_DIST }}/licenses/{{ .Os }}_{{ .Arch }}/**"',
      "src: " + JSON.stringify(archiveGlob),
    );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    assert.equal(process.argv[2], "--output");
    assert.ok(
      process.argv[3] && process.argv.length === 4,
      "需要 --output 配置文件路径",
    );
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const directory = execFileSync(
      process.execPath,
      [join(root, "scripts/project-layout.mjs"), "--field", "releaseRoot"],
      { encoding: "utf8" },
    ).trim();
    const source = await readFile(join(root, ".goreleaser.yaml"), "utf8");
    await writeFile(
      resolve(process.argv[3]),
      renderReleaseConfig(source, directory),
      { mode: 0o600 },
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
