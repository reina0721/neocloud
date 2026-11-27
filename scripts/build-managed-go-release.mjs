// 托管 Go 发布包与现有独立 Go / Docker 归档使用不同的附件名。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bundleLicenses } from "../frontend/tooling/bundle-licenses.mjs";
import { prepareLegacyGoSource, releaseFamily } from "./release-go-source.mjs";

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
    "web-dir": { type: "string" },
    "web-licenses-dir": { type: "string" },
    profile: { type: "string" },
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
assert.ok(!values["web-licenses-dir"] || values["web-dir"], "Web 许可目录需要同时指定 --web-dir");
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
const family = releaseFamily(values.profile);
const work = await mkdtemp(join(tmpdir(), "neocloud-managed-go-"));
const suffix = os === "windows" ? ".exe" : "";
const binaryName = family + suffix;
const hostName = family + "-host" + suffix;
const manifest = { version, commit, os, arch, hostProtocol: 1, ...migration };
const profile = values["web-dir"] ? "managed-full" : "managed-go";
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

async function copyStaticFiles(source, target, inventory, prefix = "") {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const item = join(source, entry.name);
    const destination = join(target, entry.name);
    const path = prefix + entry.name;
    if (entry.isDirectory()) {
      await copyStaticFiles(item, destination, inventory, path + "/");
    } else {
      assert.ok(entry.isFile(), `Web 导出包含非普通文件：${path}`);
      await mkdir(target, { recursive: true });
      await copyFile(item, destination);
      const hash = createHash("sha256");
      let size = 0;
      for await (const content of createReadStream(destination)) {
        hash.update(content);
        size += content.length;
      }
      inventory.push({ path, size, sha256: hash.digest("hex") });
    }
  }
}

async function includeStaticWeb() {
  const source = resolve(values["web-dir"]);
  assert.ok((await lstat(source)).isDirectory(), "Web 导出目录必须是实际目录");
  const identity = JSON.parse(await readFile(join(source, "web-build.json"), "utf8"));
  assert.deepEqual(identity, { buildId: commit }, "静态 Web 与当前 Go 发布提交不一致");
  const inventory = [];
  await copyStaticFiles(source, join(work, "web"), inventory);
  inventory.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const index = JSON.stringify(inventory) + "\n";
  await writeFile(join(work, "web-files.json"), index, { flag: "wx" });
  const licenses = join(work, "third-party", "node");
  if (values["web-licenses-dir"]) {
    const prepared = resolve(values["web-licenses-dir"]);
    const list = JSON.parse(await readFile(join(prepared, "inventory.json"), "utf8"));
    assert.ok(Array.isArray(list) && list.length > 0, "缺少 Web 依赖许可清单");
    await cp(prepared, licenses, { recursive: true, errorOnExist: true });
  } else {
    await mkdir(licenses, { recursive: true });
    await bundleLicenses(join(root, "frontend"), licenses);
  }
  Object.assign(manifest, {
    profile, hostProtocol: 2, webId: commit,
    webInventorySha256: createHash("sha256").update(index).digest("hex"),
  });
}

try {
  await mkdir(output, { recursive: true });
  const goRoot = family === "clouddrive" ? await prepareLegacyGoSource(root, join(work, ".legacy-go")) : root;
  const binaries = [
    [binaryName, "./cmd/app"],
    [hostName, `./cmd/${family}-host`],
  ];
  for (const [name, entry] of binaries) {
    execFileSync(
      "go",
      ["build", "-trimpath", "-buildvcs=false", "-ldflags", buildFlags, "-o", join(work, name), entry],
      {
        cwd: goRoot,
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
      "--source", goRoot,
      "--goos", os, "--goarch", arch,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (goRoot !== root) await rm(goRoot, { recursive: true, force: true });
  for (const file of content) {
    await mkdir(dirname(join(work, file)), { recursive: true });
    await copyFile(join(root, file), join(work, file));
  }
  if (profile === "managed-full") await includeStaticWeb();
  await copyFile(join(root, "docs/operations/backend-archive.md"), join(work, "README.md"));
  await writeFile(join(work, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
  });
  const archive = join(output, `${family}_${version}_${os}_${arch}_${profile}.zip`);
  execFileSync(
    "go",
    [
      "run", "./internal/tools/native-archive", "--managed", "--output", archive,
      "--profile", profile,
      "--work", work, "--version", version, "--commit", commit, "--os", os, "--arch", arch,
    ],
    { cwd: root, stdio: "inherit" },
  );
  console.log(archive);
} finally {
  await rm(work, { recursive: true, force: true });
}
