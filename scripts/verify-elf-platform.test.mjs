import assert from "node:assert/strict";
import test from "node:test";
import { verifyHeader } from "./verify-elf-platform.mjs";

function header(machine) {
  const bytes = Buffer.alloc(20);
  bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

test("两种架构的 ELF machine 编号分别接受", () => {
  verifyHeader(header(62), "amd64");
  verifyHeader(header(183), "arm64");
});
test("拒绝元数据为 ARM64 但程序为 x86-64 的发布包及其反向错误", () => {
  assert.throws(() => verifyHeader(header(62), "arm64"), /架构与 arm64/);
  assert.throws(() => verifyHeader(header(183), "amd64"), /架构与 amd64/);
});
test("拒绝截断、非 ELF、32 位、大端及未知架构", () => {
  assert.throws(() => verifyHeader(header(62).subarray(0, 19), "amd64"), /不完整/);
  for (const [offset, value] of [
    [0, 0], [4, 1], [5, 2], [6, 0],
  ]) {
    const bytes = header(62);
    bytes[offset] = value;
    assert.throws(() => verifyHeader(bytes, "amd64"), /ELF 程序/);
  }
  assert.throws(() => verifyHeader(header(62), "riscv64"), /仅支持/);
});
