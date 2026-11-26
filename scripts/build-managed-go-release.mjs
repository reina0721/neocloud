// 托管 Go 发布包与现有独立 Go / Docker 归档使用不同的附件名。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    version: { type: "string" },
    commit: { type: "string" },
    os: { type: "string" },
    arch: { type: "string" },
    out: { type: "string" },
    "base-version": { type: "string" },
    "base-commit": { type: "string" },
  },
});
const { version, commit, os, arch, out } = values;
assert.match(
  version ?? "",
  /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/,
);
assert.match(commit ?? "", /^[0-9a-f]{40}$/);
assert.ok(["windows/amd64", "linux/amd64", "linux/arm64"].includes(`${os}/${arch}`));
assert.ok(out, "缺少 --out");
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  commit,
);
const buildTime = execFileSync("git", ["show", "-s", "--format=%cI", commit], {
  cwd: root,
  encoding: "utf8",
}).trim();

// 首个协议基线可以没有前序迁移。后续由发布者在仓库同一提交中显式声明升级边。
let migration = {};
try {
  migration = JSON.parse(
    await readFile(join(root, ".github/managed-go-migrations.json"), "utf8"),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
assert.ok(migration && typeof migration === "object" && !Array.isArray(migration));
for (const key of Object.keys(migration))
  assert.ok(
    ["fromVersion", "fromCommit", "onlinePlans"].includes(key),
    `未知原生迁移字段 ${key}`,
  );
const baseline = values["base-version"];
const baselineCommit = values["base-commit"];
assert.equal(Boolean(baseline), Boolean(baselineCommit));
if (baseline) {
  if (migration.fromVersion !== undefined) assert.equal(migration.fromVersion, baseline);
  if (migration.fromCommit !== undefined) assert.equal(migration.fromCommit, baselineCommit);
  migration.fromVersion = baseline;
  migration.fromCommit = baselineCommit;
}

const output = resolve(out);
const work = await mkdtemp(join(tmpdir(), "clouddrive-managed-go-"));
const suffix = os === "windows" ? ".exe" : "";
const binaryName = "clouddrive" + suffix;
const hostName = "clouddrive-host" + suffix;
const manifest = { version, commit, os, arch, hostProtocol: 1, ...migration };
const content = [
  "LICENSE",
  "NOTICE",
  "SOURCES.json",
  "config.example.yaml",
  "locales/messages.zh-CN.yaml",
  "internal/module/todo/binding/i18n/locales/messages.zh-CN.yaml",
];
const buildFlags = [
  "-s",
  "-w",
  `-X=main.buildVersion=${version}`,
  `-X=main.buildCommit=${commit}`,
  `-X=main.buildTime=${buildTime}`,
  "-X=main.buildDirty=false",
].join(" ");

try {
  await mkdir(output, { recursive: true });
  const binaries = [
    [binaryName, "./cmd/app"],
    [hostName, "./cmd/clouddrive-host"],
  ];
  for (const [name, entry] of binaries) {
    execFileSync(
      "go",
      ["build", "-trimpath", "-buildvcs=false", "-ldflags", buildFlags, "-o", join(work, name), entry],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: "0" },
      },
    );
  }
  execFileSync(
    process.execPath,
    [
      join(root, "scripts/prepare-go-licenses.mjs"),
      "--managed-host", "--output", join(work, "third-party"),
      "--goos", os, "--goarch", arch,
    ],
    { cwd: root, stdio: "inherit" },
  );
  for (const file of content) {
    await mkdir(dirname(join(work, file)), { recursive: true });
    await copyFile(join(root, file), join(work, file));
  }
  await copyFile(join(root, "docs/operations/backend-archive.md"), join(work, "README.md"));
  await writeFile(join(work, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
  });
  const archive = join(output, `clouddrive_${version}_${os}_${arch}_managed-go.zip`);
  execFileSync(
    "go",
    [
      "run", "./internal/tools/native-archive", "--managed", "--output", archive,
      "--work", work, "--version", version, "--commit", commit, "--os", os, "--arch", arch,
    ],
    { cwd: root, stdio: "inherit" },
  );
  console.log(archive);
} finally {
  await rm(work, { recursive: true, force: true });
}
