// 按实际构建平台收集许可；输出只进入忽略的发布目录。
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    goos: { type: "string" },
    goarch: { type: "string" },
    "go-executable": { type: "string", default: "go" },
    "from-module": { type: "boolean", default: false },
    "managed-host": { type: "boolean", default: false },
    source: { type: "string" },
  },
});
assert.ok(values.output, "需要 --output");
assert.ok(["linux", "windows", "darwin"].includes(values.goos), "不支持的 GOOS");
assert.ok(["amd64", "arm64"].includes(values.goarch), "不支持的 GOARCH");
const output = resolve(values.output);
const go = values["go-executable"];
const source = resolve(values.source || process.env.NEOCLOUD_RELEASE_GO_ROOT || ".");
const module = /^module github\.com\/reina0721\/(neocloud|clouddrive)\r?$/m.exec(await readFile(join(source, "go.mod"), "utf8"))?.[1];
assert.ok(module, "Go 许可来源必须属于已知命名系列");
const packages = values["managed-host"]
  ? ["./cmd/app", `./cmd/${module}-host`]
  : ["./cmd/app"];
const args = ["save", ...packages, "--save_path=" + output];
let command = "go-licenses";
if (values["from-module"]) {
  const tools = await readFile(new URL("./tool-versions.env", import.meta.url), "utf8");
  const version = /^GO_LICENSES_VERSION=(v[\d.]+)\s*$/m.exec(tools)?.[1];
  assert.ok(version, "缺少 go-licenses 的固定版本");
  command = go;
  args.unshift("run", "github.com/google/go-licenses/v2@" + version);
}
execFileSync(command, args, {
  cwd: source,
  stdio: "inherit",
  env: {
    ...process.env,
    CGO_ENABLED: "0",
    GOOS: values.goos,
    GOARCH: values.goarch,
  },
});
const goroot = execFileSync(go, ["env", "GOROOT"], {
  encoding: "utf8",
}).trim();
await mkdir(output, { recursive: true });
await copyFile(join(goroot, "LICENSE"), join(output, "GO-LICENSE"));
