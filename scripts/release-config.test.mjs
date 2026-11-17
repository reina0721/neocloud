import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReleaseConfig } from "./release-config.mjs";
test("发布目录替换为真实路径，保留 GoReleaser 其余模板", () => {
  const source =
    'version: 2\ndist: "{{ .Env.GORELEASER_DIST }}"\nheader: "{{ .Version }}"\n';
  for (const directory of [
    "/tmp/release assets",
    "C:\\Users\\Reina\\release assets",
  ]) {
    const result = renderReleaseConfig(source, directory);
    assert.equal(JSON.parse(result.split("\n")[1].slice(6)), directory);
    assert.ok(result.includes("{{ .Version }}"));
  }
  assert.throws(() => renderReleaseConfig(source, ""), /发布目录无效/);
  assert.throws(
    () => renderReleaseConfig(source + source, "/tmp/output"),
    /一个受控/,
  );
  assert.throws(
    () => renderReleaseConfig("dist: dist", "/tmp/output"),
    /一个受控/,
  );
});
