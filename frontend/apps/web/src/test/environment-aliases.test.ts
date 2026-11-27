import { expect, it } from 'vitest';
import { readNeoCloudEnv } from '../../runtime/environment.mjs';

it('兼容前后两个命名的环境值，拒绝明确冲突且不暴露内容', () => {
  expect(readNeoCloudEnv('BACKEND_URL', {})).toBeUndefined();
  expect(readNeoCloudEnv('BACKEND_URL', { CLOUDDRIVE_BACKEND_URL: 'legacy' })).toBe('legacy');
  expect(readNeoCloudEnv('BACKEND_URL', { NEOCLOUD_BACKEND_URL: 'canonical' })).toBe('canonical');
  expect(
    readNeoCloudEnv('BACKEND_URL', {
      NEOCLOUD_BACKEND_URL: 'same',
      CLOUDDRIVE_BACKEND_URL: 'same',
    }),
  ).toBe('same');
  expect(() =>
    readNeoCloudEnv('BACKEND_URL', {
      NEOCLOUD_BACKEND_URL: 'one',
      CLOUDDRIVE_BACKEND_URL: 'two',
    }),
  ).toThrow('NEOCLOUD_BACKEND_URL conflicts with its legacy environment variable.');
});
