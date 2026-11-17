// 镜像的平台标签不能证明其中的 Go 程序架构；直接检查实际 ELF 文件头。
import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function verifyHeader(header, arch) {
  const machines = { amd64: 62, arm64: 183 };
  assert.ok(Object.hasOwn(machines, arch), "仅支持 amd64/arm64");
  assert.ok(header.length >= 20, "ELF 文件头不完整");
  assert.deepEqual(
    [...header.subarray(0, 7)],
    [127, 69, 76, 70, 2, 1, 1],
    "需要 64 位、小端、版本 1 的 ELF 程序",
  );
  assert.equal(
    header.readUInt16LE(18),
    machines[arch],
    `ELF 程序架构与 ${arch} 镜像不一致`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [, , path, arch] = process.argv;
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    verifyHeader(header.subarray(0, bytesRead), arch);
    console.log(`镜像内 ELF 程序架构通过：${arch}`);
  } finally {
    await file.close();
  }
}
