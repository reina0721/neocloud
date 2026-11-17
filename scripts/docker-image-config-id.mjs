// 固定使用镜像配置内容的 SHA-256，不使用不同 Docker 存储后端的显示 ID。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function imageConfigId(archive, reference, arch) {
  const extract = (name) => execFileSync("tar", ["-xOf", archive, name]);
  const entries = JSON.parse(extract("manifest.json").toString("utf8"));
  assert.ok(Array.isArray(entries), "Docker 保存清单无效");
  const normalize = (name) => name.replace(/^docker\.io\/library\//, "");
  const matches = [];
  for (const entry of entries) {
    if (!entry.RepoTags?.some((tag) => normalize(tag) === normalize(reference)))
      continue;
    const path = entry.Config;
    assert.match(
      path,
      /^(?:blobs\/sha256\/[a-f0-9]{64}|[a-f0-9]{64}\.json)$/,
      "镜像配置路径无效",
    );
    const bytes = extract(path);
    const hash = createHash("sha256").update(bytes).digest("hex");
    assert.ok(path.includes(hash), "镜像配置内容与名称摘要不符");
    const config = JSON.parse(bytes.toString("utf8"));
    if (config.os === "linux" && config.architecture === arch)
      matches.push("sha256:" + hash);
  }
  assert.equal(
    matches.length,
    1,
    `必须找到唯一的 ${reference} linux/${arch} 配置`,
  );
  return matches[0];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  console.log(imageConfigId(...process.argv.slice(2)));
}
