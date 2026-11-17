import { expect, it, vi } from 'vitest';
import { installUUIDCompatibility } from './crypto-compatibility';

it('保留浏览器原生 UUID，不替换现有能力', () => {
  const native = vi.fn();
  const crypto = { randomUUID: native } as unknown as Crypto;
  installUUIDCompatibility(crypto);
  expect(Object.getOwnPropertyDescriptor(crypto, 'randomUUID')?.value).toBe(native);
});

it('HTTP 兼容使用每次独立的 CSPRNG 熵，正确设置 UUID 版本和 variant', () => {
  const random = vi.fn((bytes: Uint8Array) => bytes.fill(255));
  const crypto = { getRandomValues: random } as unknown as Crypto;
  installUUIDCompatibility(crypto);
  expect(crypto.randomUUID()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  expect(crypto.randomUUID()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  expect(random).toHaveBeenCalledTimes(2);
  expect(random.mock.calls[0]![0]).not.toBe(random.mock.calls[1]![0]);
});

it('随机源失败直接报错，不降级为可预测的随机数', () => {
  const crypto = {
    getRandomValues: () => {
      throw new Error('entropy unavailable');
    },
  } as unknown as Crypto;
  installUUIDCompatibility(crypto);
  expect(() => crypto.randomUUID()).toThrow('entropy unavailable');
});
