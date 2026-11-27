import { defineConfig } from '@playwright/test';
import { readPreviewAccess } from './file-tests/reading-fixture';
import { readNeoCloudEnv } from './apps/web/runtime/environment.mjs';

// 旧 fixture 仍用旧环境键。Canonical 调用者使用同一组值和兼容检查。
for (const key of Object.keys(process.env)) {
  if (!key.startsWith('NEOCLOUD_')) continue;
  const suffix = key.slice('NEOCLOUD_'.length);
  const value = readNeoCloudEnv(suffix);
  if (value !== undefined) process.env[`CLOUDDRIVE_${suffix}`] = value;
}
const access = readPreviewAccess();
// 旧用例从不同目录 resolve 凭据；统一成绝对路径后不会改变其目标。
process.env.CLOUDDRIVE_FILE_TEST_ACCESS = access.path;
process.env.NEOCLOUD_FILE_TEST_ACCESS = access.path;
export default defineConfig({
  testDir: './file-tests',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: access.origin,
    browserName: 'chromium',
    locale: 'zh-CN',
    ignoreHTTPSErrors: Boolean(process.env.CLOUDDRIVE_TEST_WEB_HTTPS_ORIGIN),
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  outputDir: 'test-results/files',
});
