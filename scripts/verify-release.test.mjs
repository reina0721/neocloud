import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  requiredAssets,
  selectDraft,
  verifyAssets,
} from "./verify-release.mjs";
const sha = "a".repeat(40),
  tag = "v0.1.0";

const readWorkflow = (name) =>
  readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8")
    .then((contents) => contents.replace(/\r\n/g, "\n"));

function triggers(workflow) {
  const body = /^on:\n([\s\S]*?)(?=^\S)/m.exec(workflow)?.[1];
  assert.ok(body, "缺少工作流触发配置");
  return [...body.matchAll(/^  ([a-z_]+):/gm)].map((match) => match[1]);
}

test("自动源码检查收敛到主分支和 PR，完整矩阵由维护者按需运行", async () => {
  const quality = await readWorkflow("quality");
  assert.deepEqual(triggers(quality), ["push", "pull_request", "workflow_dispatch"]);
  assert.match(quality, /^    branches: \[main\]$/m);
  for (const job of ["windows", "linux", "webui-windows", "webui-linux", "security"]) {
    assert.match(
      quality,
      new RegExp(`^  ${job}:\\n    if: github\\.event_name == 'workflow_dispatch'$`, "m"),
    );
  }
  assert.match(quality, /oasdiff breaking/);
  assert.match(quality, /openapi-breaking:[\s\S]*?github\.event_name == 'pull_request'/);
  for (const name of ["database", "container", "visual-review"]) {
    assert.deepEqual(triggers(await readWorkflow(name)), ["workflow_dispatch"]);
  }
});

test("正式 tag 只执行发布构建和实际附件检查", async () => {
  const release = await readWorkflow("release");
  assert.deepEqual(triggers(release), ["push"]);
  assert.match(release, /^    tags:\n      - "v\*"$/m);
  assert.match(release, /git cat-file -t/);
  assert.match(release, /git merge-base --is-ancestor[^\n]+refs\/remotes\/origin\/main/);
  assert.match(release, /"\$GITHUB_REF_NAME" "\$GITHUB_SHA" >> "\$GITHUB_STEP_SUMMARY"/);
  assert.match(release, /contains\(github\.ref_name, '-'\) \|\| needs\.managed-go-bundles\.result == 'success'/);
  assert.doesNotMatch(
    release,
    /wait-release-gates|\/actions\/runs|node --test|playwright|managed-go-acceptance|test-offline-(?:release|transition)|test-docker-maintenance/,
  );
  assert.equal([...release.matchAll(/\bsign-blob\b/g)].length, 1);
  assert.equal([...release.matchAll(/\bgo test\b/g)].length, 1);
  assert.match(release, /go test[^\n]+TestSignedFullReleaseBoot/);
  assert.match(release, /\$env:CLOUDDRIVE_COSIGN = \$cosign[\s\S]+go test[^\n]+TestSignedFullReleaseBoot/);
  assert.equal([...release.matchAll(/test-docker-release\.mjs/g)].length, 1);
  assert.match(release, /--artifact-smoke/);

  const publish = /^  publish:\n([\s\S]+)$/m.exec(release)?.[1];
  assert.ok(publish, "缺少正式发布任务");
  assert.match(publish, /needs: \[release, docker-acceptance, managed-full-acceptance\]/);
  assert.match(publish, /!contains\(github\.ref_name, '-'\)/);
  assert.match(publish, /verify-release\.mjs assets[\s\S]+verify-blob[\s\S]+gh release edit/);
  assert.match(publish, /--certificate-identity "https:\/\/github\.com\/\$GITHUB_REPOSITORY\/\.github\/workflows\/release\.yml@\$GITHUB_REF"/);
  assert.match(publish, /gh release edit[^\n]+--draft=false[^\n]+--latest/);
});
test("从完整分页列表读取 draft，保留 REST 附件元数据", () => {
  const draft = {
    tag_name: tag,
    draft: true,
    prerelease: false,
    assets: [{ name: "install.sh", size: 42 }],
  };
  assert.equal(
    selectDraft([[{ tag_name: "v9.9.9", draft: false }], [], [draft]], tag),
    draft,
  );
});
test("缺失、重复、已发布或预发布 Release 均禁止提升 draft", () => {
  const draft = { tag_name: tag, draft: true, prerelease: false };
  assert.throws(() => selectDraft([[]], tag), /恰好找到一个/);
  assert.throws(() => selectDraft([[draft], [draft]], tag), /恰好找到一个/);
  assert.throws(
    () => selectDraft([[{ ...draft, draft: false }]], tag),
    /保持 draft/,
  );
  assert.throws(
    () => selectDraft([[{ ...draft, prerelease: true }]], tag),
    /预发布/,
  );
  assert.throws(() => selectDraft([draft], tag), /分页列表无效/);
  assert.throws(() => selectDraft([[draft]], "v0.1.0-rc.1"), /仅正式版本/);
});
test("draft CLI 仅输出可被后续附件门禁直接读取的 JSON", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "release-pages-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const draft = { tag_name: tag, draft: true, prerelease: false, assets: [] };
  const path = join(directory, "pages.json");
  await writeFile(path, JSON.stringify([[], [draft]]));
  const output = execFileSync(
    process.execPath,
    ["scripts/verify-release.mjs", "draft", path, tag],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), draft);
});
test("预发布标签不能自动提升为正式版本", () => {
  assert.throws(() => requiredAssets("v0.1.0-rc.1"), /仅正式版本/);
});

async function fixture(t, { armSha = sha, layout = true, armToolMachine = 183 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "release-assets-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installerPath = join(directory, "source-installer");
  await writeFile(installerPath, "#!/usr/bin/env bash\necho fixture\n");
  for (const name of requiredAssets(tag)) {
    let bytes = "fixture-archive";
    if (name.endsWith(".spdx.json"))
      bytes = JSON.stringify({
        spdxVersion: "SPDX-2.3",
        packages: [{ name: "fixture" }],
      });
    if (name.startsWith("clouddrive-maintenance_")) {
      bytes = Buffer.alloc(20);
      bytes.set([127, 69, 76, 70, 2, 1, 1]);
      bytes.writeUInt16LE(name.endsWith("arm64") ? armToolMachine : 62, 18);
    }
    if (name === "install.sh") bytes = await readFile(installerPath);
    if (name === "version.txt") bytes = tag + "\n";
    await writeFile(join(directory, name), bytes);
  }
  for (const arch of ["amd64", "arm64"]) {
    const stage = join(directory, arch);
    await mkdir(stage);
    await writeFile(join(stage, "compose.yaml"), "services: {}\n");
    await writeFile(join(stage, "images.tar"), "fixture");
    await writeFile(join(stage, "install.sh"), await readFile(installerPath));
    await writeFile(
      join(stage, "images.env"),
      `API_IMAGE=clouddrive-api:${tag}-${arch}\nWEB_IMAGE=clouddrive-web:${tag}-${arch}\n`,
    );
    await writeFile(
      join(stage, "manifest.txt"),
      `FORMAT=1\n${layout ? "INSTANCE_LAYOUT=1\n" : ""}OFFLINE_MAINTENANCE=1\nVERSION=${tag}\nARCH=${arch}\nCOMMIT=${arch === "arm64" ? armSha : sha}\nAPI_ID=sha256:${"1".repeat(64)}\nWEB_ID=sha256:${"2".repeat(64)}\n`,
    );
    execFileSync("tar", [
      "-czf",
      join(directory, `clouddrive_${tag}_linux_${arch}_docker.tar.gz`),
      "-C",
      stage,
      "compose.yaml",
      "images.env",
      "images.tar",
      "install.sh",
      "manifest.txt",
    ]);
  }
  const lines = [];
  for (const name of requiredAssets(tag))
    if (!["checksums.txt", "checksums.txt.sigstore.json"].includes(name))
      lines.push(
        createHash("sha256")
          .update(await readFile(join(directory, name)))
          .digest("hex") +
          "  " +
          name,
      );
  await writeFile(join(directory, "checksums.txt"), lines.join("\n") + "\n");
  const release = { tag_name: tag, draft: true, prerelease: false, assets: [] };
  for (const name of requiredAssets(tag))
    release.assets.push({
      name,
      size: (await stat(join(directory, name))).size,
      state: "uploaded",
    });
  return { release, directory, tag, sha, installerPath };
}
test("完整双架构产物及其清单可通过验收", async (t) =>
  verifyAssets(await fixture(t)));

test("缺少自定义布局能力的草稿产物不能发布", async (t) => {
  await assert.rejects(verifyAssets(await fixture(t, { layout: false })), /INSTANCE_LAYOUT/);
});
for (const missing of [
  "checksums.txt.sigstore.json",
  "clouddrive_v0.1.0_windows_amd64_managed-full.zip",
  `clouddrive_${tag}_linux_arm64_docker.tar.gz`,
]) {
  test("缺少必要附件必须阻止发布：" + missing, async (t) => {
    const f = await fixture(t);
    f.release.assets = f.release.assets.filter((a) => a.name !== missing);
    await assert.rejects(verifyAssets(f), /缺少附件/);
  });
}
test("摘要损坏和未纳入签名清单的 SBOM 均阻止发布", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.directory, "install.sh"),
    "x".repeat(f.release.assets.find((a) => a.name === "install.sh").size),
  );
  await assert.rejects(verifyAssets(f), /摘要不符/);
  const g = await fixture(t);
  const checksumsPath = join(g.directory, "checksums.txt");
  await writeFile(
    checksumsPath,
    (await readFile(checksumsPath, "utf8"))
      .split("\n")
      .filter((x) => !x.endsWith("clouddrive-api_v0.1.0_arm64.spdx.json"))
      .join("\n"),
  );
  g.release.assets.find((a) => a.name === "checksums.txt").size = (
    await stat(checksumsPath)
  ).size;
  await assert.rejects(verifyAssets(g), /未受校验清单保护/);
});
test("即使摘要正确，另一提交的镜像包仍不能发布", async (t) => {
  const f = await fixture(t, { armSha: "b".repeat(40) });
  await assert.rejects(verifyAssets(f), /配套镜像身份不符/);
});

test("即使摘要正确，架构错误的维护程序仍不能发布", async (t) => {
  const f = await fixture(t, { armToolMachine: 62 });
  await assert.rejects(verifyAssets(f), /架构/);
});
