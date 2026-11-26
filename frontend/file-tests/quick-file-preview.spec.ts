import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from './preview-test';
import { openReadingFixtureFolder, readPreviewAccess } from './reading-fixture';

async function login(page: Page) {
  const access = readPreviewAccess();
  await page.goto('/login?returnTo=%2Fhome');
  await page.getByLabel('邮箱', { exact: true }).fill(access.username);
  await page.getByLabel('密码', { exact: true }).fill(access.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
}

async function textFiles(page: Page, earlierFiles = 0) {
  const folder = await openReadingFixtureFolder(page, '快速预览-');
  const files = await page.evaluate(
    async ({ parentId, key, earlierFiles }) => {
      const base = '/api/console/v1';
      const { token } = (await (await fetch(base + '/auth/csrf')).json()) as { token: string };
      async function create(name: string, text: string) {
        const response = await fetch(base + '/native/files/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ parentId, name, text, key: key + name }),
        });
        if (!response.ok) throw new Error('Fixture text HTTP ' + response.status);
        return (await response.json()) as { id: string; name: string };
      }
      for (let index = 0; index < earlierFiles; index++) {
        await create('00-' + String(index).padStart(2, '0') + '.txt', 'Earlier file');
      }
      const created: { id: string; name: string }[] = [];
      for (const [index, text] of ['alpha', 'bravo', 'charlie'].entries()) {
        created.push(await create(String(index + 1) + '-' + text + '.txt', text));
      }
      return created;
    },
    { parentId: folder.id, key: randomUUID(), earlierFiles },
  );
  await page.reload();
  return files;
}

test('真实文本预览保留目录、邻项历史及原行，编辑继续用阅读工作区', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await login(page);
  const [first, middle, last] = await textFiles(page);
  if (!first || !middle || !last) throw new Error('文件夹具不完整');
  const listing = page.url();
  const file = page.getByRole('button', { name: first.name, exact: true });
  const preview = page.locator('[data-file-quick-preview]');
  const stage = preview.locator('[data-file-preview-body]');
  const close = page.getByRole('button', { name: '关闭', exact: true });
  const previous = page.getByRole('button', { name: '上一个文件', exact: true });
  const next = page.getByRole('button', { name: '下一个文件', exact: true });
  await file.click();
  await expect(page).toHaveURL(listing + '&preview=' + first.id);
  await expect(stage).toContainText('alpha');
  await expect(close).toBeFocused();
  await expect(previous).toBeDisabled();
  await expect(preview.locator('[contenteditable="true"],textarea')).toHaveCount(0);
  const nextX = (await next.boundingBox())?.x;

  let finishSecond = () => {};
  let secondRequested = () => {};
  const secondHeld = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  const secondStarted = new Promise<void>((resolve) => {
    secondRequested = resolve;
  });
  await page.route(
    '**/native/files/' + middle.id + '/content',
    async (route) => {
      secondRequested();
      await secondHeld;
      await route.continue().catch(() => {});
    },
    { times: 1 },
  );
  try {
    await next.click();
    await expect(page).toHaveURL(listing + '&preview=' + middle.id);
    await secondStarted;
    await expect(stage).toHaveAttribute('data-preview-status', 'loading');
    expect((await next.boundingBox())?.x).toBe(nextX);
    await next.click();
  } finally {
    finishSecond();
  }
  await expect(page).toHaveURL(listing + '&preview=' + last.id);
  await expect(stage).toContainText('charlie');
  await expect(stage).not.toContainText('bravo');
  await expect(next).toBeDisabled();
  await page.goBack();
  await expect(page).toHaveURL(listing);
  await expect(preview).toHaveCount(0);
  await expect(file).toBeFocused();

  await page.goForward();
  await expect(page).toHaveURL(listing + '&preview=' + last.id);
  await expect(stage).toContainText('charlie');
  const edit = page.getByRole('button', { name: '编辑', exact: true });
  await edit.click();
  await expect(page).toHaveURL(/\/home\/view\?/);
  const full = page.getByRole('dialog', { name: last.name, exact: true });
  await expect(full.getByRole('button', { name: '保存', exact: true })).toBeVisible();
  await full.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page).toHaveURL(listing);

  for (const [width, height] of [
    [320, 800],
    [390, 844],
    [844, 390],
    [1280, 720],
    [1440, 900],
    [767, 700],
    [768, 700],
    [1280, 479],
    [1280, 480],
  ] as const) {
    await page.setViewportSize({ width, height });
    await file.click();
    await expect(stage).toContainText('alpha');
    const bounds = (await stage.boundingBox())!;
    const compact = width < 768 || height < 480;
    expect(bounds.x).toBeGreaterThanOrEqual(compact ? 12 : 48);
    expect(bounds.width).toBeLessThanOrEqual(Math.min(1152, width - (compact ? 24 : 96)));
    expect(bounds.height).toBeLessThan(240);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    if (width === 320 || width === 1440)
      await page.screenshot({ path: info.outputPath('quick-text-' + width + '.png') });
    await close.press('Escape');
    await expect(preview).toHaveCount(0);
    await expect(page).toHaveURL(listing);
  }
});

test('先显示预览外壳，关闭取消实读，失败后原地重试', async ({ page }, info) => {
  await login(page);
  const [first] = await textFiles(page);
  if (!first) throw new Error('文件夹具不完整');
  const listing = page.url();
  const file = page.getByRole('button', { name: first.name, exact: true });
  const dialog = page.getByRole('dialog', { name: first.name, exact: true });
  let release = () => {};
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = () => {};
  const request = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route(
    '**/applications/active',
    async (route) => {
      reached();
      await delay;
      await route.continue().catch(() => {});
    },
    { times: 1 },
  );
  await file.click();
  await request;
  try {
    await expect(dialog.getByRole('status')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
    await page.screenshot({ path: info.outputPath('policy-loading.png') });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  } finally {
    release();
  }
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(listing);
  await expect(file).toBeFocused();

  await page.route('**/applications/active', (route) => route.fulfill({ status: 503, json: {} }), {
    times: 1,
  });
  await file.click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expect(dialog.locator('[data-file-preview-body]')).toContainText('alpha');
  const direct = page.url();
  await page.reload();
  await expect(dialog.locator('[data-file-preview-body]')).toContainText('alpha');
  await expect(page).toHaveURL(direct);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page).toHaveURL(listing);
  await expect(dialog).toHaveCount(0);
});

test('同一预览层跨文本、PDF、图片和视频保留返回路径', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await textFiles(page);
  const listHref = page.url();
  const imageBytes = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 192;
      canvas.height = 288;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#0f766e';
      context.fillRect(0, 0, 192, 288);
      return canvas.toDataURL('image/png').split(',')[1]!;
    }),
    'base64',
  );
  const upload = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('menuitem', { name: '上传文件', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '使用此位置', exact: true }).click();
  await (
    await upload
  ).setFiles([
    {
      name: '4-document.pdf',
      mimeType: 'application/pdf',
      buffer: await readFile(resolve(__dirname, 'fixtures/pdf/reader.pdf')),
    },
    { name: '5-portrait.png', mimeType: 'image/png', buffer: imageBytes },
    {
      name: '6-clip.mp4',
      mimeType: 'video/mp4',
      buffer: await readFile(resolve(__dirname, 'fixtures/hls/range.mp4')),
    },
  ]);
  const queue = page.getByRole('dialog', { name: '上传队列', exact: true });
  await expect(queue.getByText('上传完成', { exact: true })).toHaveCount(3);
  await queue.getByRole('button', { name: '关闭', exact: true }).click();
  const opener = page.getByRole('button', { name: '3-charlie.txt', exact: true });
  await expect(page.getByRole('button', { name: '6-clip.mp4', exact: true })).toBeVisible();
  await opener.click();
  const shell = page.locator('[data-file-quick-preview]');
  const body = shell.locator('[data-file-preview-body]');
  const next = page.getByRole('button', { name: '下一个文件', exact: true });
  await expect(body).toContainText('charlie');
  const overlay = await shell.elementHandle();
  await next.click();
  await expect(body).toHaveAttribute('data-kind', 'pdf');
  await expect(body.frameLocator('iframe').locator('canvas').first()).toBeVisible();
  expect((await body.boundingBox())!.width).toBeLessThanOrEqual(1120);
  await page.screenshot({ path: info.outputPath('quick-pdf-desktop.png') });
  await next.click();
  await expect(body).toHaveAttribute('data-kind', 'image');
  const image = body.locator('img').first();
  await expect(image).toBeVisible();
  await expect.poll(async () => (await image.boundingBox())?.width).toBe(192);
  await expect.poll(async () => (await image.boundingBox())?.height).toBe(288);
  expect(await overlay?.evaluate((element) => element.isConnected)).toBe(true);
  await page.screenshot({ path: info.outputPath('quick-portrait-desktop.png') });

  await next.click();
  await expect(body).toHaveAttribute('data-kind', 'video');
  const video = body.locator('video');
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(2);
  expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await expect(next).toBeDisabled();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(video).toBeInViewport();
  await page.screenshot({ path: info.outputPath('quick-video-landscape.png') });
  const videoHref = page.url();
  await page.getByRole('button', { name: '关闭', exact: true }).press('Escape');
  await expect(page).toHaveURL(listHref);
  await expect(shell).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL(videoHref);
  await expect(body).toHaveAttribute('data-kind', 'video');
  await page.goBack();
  await expect(page).toHaveURL(listHref);
  await expect(opener).toBeFocused();
});

test('预览和完整编辑关闭后保留深处列表的滚动和原始焦点', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  await login(page);
  const [first] = await textFiles(page, 16);
  if (!first) throw new Error('文件夹具不完整');
  const listing = page.url();
  const source = page.getByRole('button', { name: first.name, exact: true });
  const scrollRegion = page.locator('[data-file-scroll-region]');
  await source.scrollIntoViewIfNeeded();
  const top = await scrollRegion.evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(100);
  await source.press('Enter');
  await expect(page.locator('[data-file-preview-body]')).toContainText('alpha');
  await page.getByRole('button', { name: '关闭', exact: true }).press('Escape');
  await expect(page).toHaveURL(listing);
  await expect(source).toBeFocused();
  expect(await scrollRegion.evaluate((element) => element.scrollTop)).toBe(top);
  await source.press('Enter');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page).toHaveURL(/\/home\/view\?/);
  await page
    .getByRole('dialog', { name: first.name, exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await expect(page).toHaveURL(listing);
  await expect(source).toBeFocused();
  expect(await scrollRegion.evaluate((element) => element.scrollTop)).toBe(top);
});
