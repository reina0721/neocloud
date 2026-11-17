// 按实际构建平台收集许可；输出只进入忽略的发布目录。
import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    goos: { type: "string" },
    goarch: { type: "string" },
  },
});
assert.ok(values.output, "需要 --output");
assert.ok(["linux", "windows"].includes(values.goos), "不支持的 GOOS");
assert.ok(["amd64", "arm64"].includes(values.goarch), "不支持的 GOARCH");
const output = resolve(values.output);
execFileSync("go-licenses", ["save", "./cmd/app", "--save_path=" + output], {
  stdio: "inherit",
  env: {
    ...process.env,
    CGO_ENABLED: "0",
    GOOS: values.goos,
    GOARCH: values.goarch,
  },
});
const goroot = execFileSync("go", ["env", "GOROOT"], {
  encoding: "utf8",
}).trim();
await mkdir(output, { recursive: true });
await copyFile(join(goroot, "LICENSE"), join(output, "GO-LICENSE"));
