import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('产品实际加载同源分发的中英文可变字体与许可证', async ({ page }) => {
  const fonts: string[] = [];
  const fontBytes: Promise<number>[] = [];
  page.on('response', (response) => {
    if (response.request().resourceType() === 'font')
      fontBytes.push(response.body().then((body) => body.byteLength));
  });
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fonts.push(request.url());
  });
  await page.goto('/login');
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((font) => font.status === 'loaded')
      .map((font) => font.family);
  });
  expect(loaded.some((family) => family.includes('Inter Variable'))).toBe(true);
  expect(loaded.some((family) => family.includes('Noto Sans SC Variable'))).toBe(true);
  expect(fonts.length).toBeGreaterThan(0);
  const downloadedBytes = (await Promise.all(fontBytes)).reduce((sum, bytes) => sum + bytes, 0);
  console.log(`登录首屏字体下载：${downloadedBytes} bytes，${fonts.length} 个分片。`);
  expect(downloadedBytes).toBeLessThanOrEqual(512 * 1024);
  for (const font of fonts) expect(new URL(font).origin).toBe(new URL(page.url()).origin);
  for (const name of ['inter', 'noto-sans-sc']) {
    const response = await page.request.get(`/fonts/licenses/${name}-OFL.txt`);
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain('SIL OPEN FONT LICENSE');
  }
});
