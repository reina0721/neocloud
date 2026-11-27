import { test, expect, type Page } from './preview-test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const readAccess = async () =>
  JSON.parse(
    (
      await readFile(
        resolve(
          __dirname,
          process.env.CLOUDDRIVE_FILE_TEST_ACCESS ?? '../../.data/preview-access.json',
        ),
        'utf8',
      )
    ).replace(/^\uFEFF/, ''),
  ) as { url: string; username: string; password: string };
async function login(page: Page) {
  const access = await readAccess();
  await page.goto(new URL('/login?returnTo=%2Fhome', access.url).href);
  await page.getByLabel('邮箱', { exact: true }).fill(access.username);
  await page.getByLabel('密码', { exact: true }).fill(access.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}
async function create(page: Page, path: string, body: unknown): Promise<{ id: string }> {
  return page.evaluate(
    async ({ path, body }) => {
      const csrf = (await (await fetch('/api/console/v1/auth/csrf')).json()) as { token: string };
      const response = await fetch('/api/console/v1/native/files' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw Error('Layout fixture API failed: ' + response.status);
      return (await response.json()) as { id: string };
    },
    { path, body },
  );
}
let fixture: { root: string; empty: string; longParent: string; longName: string };
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  try {
    await login(page);
    const root = await create(page, '/folders', {
      parentId: '',
      name: '视觉密度-' + randomUUID().slice(0, 8),
    });
    const empty = await create(page, '/folders', { parentId: root.id, name: '空目录' });
    const longName = 'LongFileName'.repeat(9) + '.txt';
    for (let index = 0; index < 29; index++)
      await create(page, '/text', {
        parentId: root.id,
        name: index === 0 ? longName : '密度样本-' + String(index).padStart(2, '0') + '.txt',
        text: '真实文件布局样本',
        key: randomUUID(),
      });
    let parent = root.id;
    for (let index = 0; index < 3; index++)
      parent = (
        await create(page, '/folders', { parentId: parent, name: '长目录名称'.repeat(12) + index })
      ).id;
    fixture = { root: root.id, empty: empty.id, longParent: parent, longName };
  } finally {
    await context.close();
  }
});
test.beforeEach(async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/home?parent=' + fixture.root);
  await expect(page.getByRole('button', { name: /^(展开|收起)文件导航$/ })).toBeVisible();
  const expand = page.getByRole('button', { name: '展开文件导航', exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator('[data-file-item]')).toHaveCount(31);
});
async function noHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
}

test('F301–308：桌面独立滚动、稳定工具、可见存储与完整品牌', async ({ page }, info) => {
  await expect
    .poll(async () => (await page.locator('.surface-file-sidebar').boundingBox())?.width)
    .toBe(256);
  const header = page.locator('[data-file-workspace-header]');
  const before = await header.boundingBox();
  const main = page.locator('[data-file-scroll-region]');
  await expect(page.getByRole('region', { name: '存储空间', exact: true })).toBeInViewport();
  const brand = page.getByRole('link', { name: 'clouddrive', exact: true });
  await expect(brand).toBeVisible();
  await expect.poll(() => brand.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await main.hover();
  await page.mouse.wheel(0, 1000);
  await expect.poll(() => main.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  expect((await header.boundingBox())?.y).toBe(before?.y);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  expect(await page.locator('[data-file-workspace]').evaluate((element) => element.scrollTop)).toBe(
    0,
  );
  await expect(page.getByRole('region', { name: '存储空间', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: '收起文件导航', exact: true }).click();
  await expect(page.getByRole('link', { name: '我的分享', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开文件导航', exact: true }).click();
  await page.screenshot({ path: info.outputPath('desktop-scroll.png') });
});
test('F316–319：紧凑网格、长名称、列表和键盘焦点', async ({ page }, info) => {
  await page.getByRole('button', { name: '视图', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '网格', exact: true }).click();
  await expect(page.locator('[data-file-view="grid"]').first()).toBeVisible();
  const cards = page.locator('[data-file-item]');
  const first = await cards.nth(0).boundingBox();
  const sixth = await cards.nth(5).boundingBox();
  expect(first?.y).toBe(sixth?.y);
  expect(first?.height).toBeLessThanOrEqual(112);
  await expect(page.getByRole('button', { name: '上一页', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toHaveCount(0);
  const long = page.getByRole('button', { name: fixture.longName, exact: true });
  await expect(long).toHaveAttribute('title', fixture.longName);
  await page.screenshot({ path: info.outputPath('compact-grid.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '视图', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '列表', exact: true }).click();
  const list = page.getByRole('table');
  await expect(list).toBeVisible();
  for (const width of [800, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    const { collectionWidth, rows } = await list.evaluate((table) => ({
      collectionWidth: table.getBoundingClientRect().width,
      rows: [...table.querySelectorAll('[role="row"]')].slice(0, 2).map((row) =>
        [...row.children].map((cell) => {
          const { x, width: cellWidth } = cell.getBoundingClientRect();
          return { x: Math.round(x), width: Math.round(cellWidth) };
        }),
      ),
    }));
    expect(rows[0]).toEqual(rows[1]);
    expect(rows[0]?.slice(2, -1).some((cell) => cell.width > 0)).toBe(collectionWidth >= 576);
    await noHorizontalOverflow(page);
  }
  expect((await cards.first().boundingBox())?.height).toBeLessThan(72);
  await long.focus();
  await page.keyboard.press('End');
  await expect.poll(() => page.locator('[data-file-entry]:focus').count()).toBe(1);
  await expect(page.locator('[data-file-entry]:focus')).toBeInViewport();
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: '视图', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '网格', exact: true }).click();
});

test('真实缩略图与短卡混排时各自保持内容高度', async ({ page }, info) => {
  const mixed = await create(page, '/folders', {
    parentId: '',
    name: '混合网格-' + randomUUID().slice(0, 8),
  });
  const note = '01-普通文本.txt';
  const photo = '02-缩略图.png';
  await create(page, '/text', {
    parentId: mixed.id,
    name: note,
    text: '短卡样本',
    key: randomUUID(),
  });
  await page.goto('/home?parent=' + mixed.id);
  await page.getByRole('button', { name: '视图', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '网格', exact: true }).click();
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 240;
    const context = canvas.getContext('2d');
    if (!context) throw Error('无法创建缩略图样本');
    context.fillStyle = '#0f766e';
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('menuitem', { name: '上传文件', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '使用此位置', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: photo,
    mimeType: 'image/png',
    buffer: Buffer.from(image, 'base64'),
  });
  const queue = page.getByRole('dialog', { name: '上传队列', exact: true });
  await expect(queue.getByText('上传完成', { exact: true })).toBeVisible();
  await queue.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();

  const cards = page.locator('[data-file-view="grid"]');
  const shortCard = cards.filter({ has: page.getByRole('button', { name: note, exact: true }) });
  const photoCard = cards.filter({ has: page.getByRole('button', { name: photo, exact: true }) });
  const thumbnail = photoCard.getByRole('img', { name: photo, exact: true });
  await expect(thumbnail).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(() => thumbnail.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(480);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const [shortBox, photoBox, thumbnailBox] = await Promise.all([
      shortCard.boundingBox(),
      photoCard.boundingBox(),
      thumbnail.boundingBox(),
    ]);
    if (!shortBox || !photoBox || !thumbnailBox) throw Error('无法测量混合网格');
    expect(shortBox.y).toBe(photoBox.y);
    expect(shortBox.height).toBeLessThanOrEqual(112);
    expect(photoBox.height).toBeGreaterThan(shortBox.height + 48);
    expect(thumbnailBox.height).toBeLessThanOrEqual(96);
    await noHorizontalOverflow(page);
    await page.screenshot({
      path: info.outputPath(`mixed-grid-${width}.png`),
      animations: 'disabled',
    });
  }
});
test('F314–315：根目录隐藏无效返回，长路径和完整路径菜单可用', async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByRole('button', { name: '上级目录', exact: true })).toHaveCount(0);
  await page.goto('/home?parent=' + fixture.longParent);
  await expect(page.getByRole('button', { name: '上级目录', exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  const path = page.getByRole('button', { name: '完整目录路径', exact: true });
  const root = page
    .getByRole('menu', { name: '完整目录路径', exact: true })
    .getByRole('menuitem', { name: '我的文件', exact: true });
  await path.click();
  await expect(root).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(path).toBeFocused();
  await page.getByRole('button', { name: '上级目录', exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(fixture.longParent));
  await path.click();
  await root.click();
  await expect(page).toHaveURL(/\/home$/);
});
test('F309–313：320px与390px工具、移动抽屉和浮层', async ({ page }, info) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await noHorizontalOverflow(page);
    await expect(page.getByRole('button', { name: '完整目录路径', exact: true })).toBeInViewport();
    await page.getByRole('button', { name: '文件导航', exact: true }).click();
    await expect(page.getByRole('link', { name: '我的分享', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '上传文件', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '当前用户', exact: true })).toBeInViewport();
  }
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath('mobile-workspace.png') });
});
test('F320：空目录轻量引导及真实上传入口', async ({ page }, info) => {
  await page.goto('/home?parent=' + fixture.empty);
  const empty = page.locator('[data-file-empty]');
  await expect(empty).toBeVisible();
  await expect(empty.getByRole('button', { name: '上传文件', exact: true })).toBeVisible();
  // 空态指引应保持自然高度，工作面下方仍可留有空间。
  const bounds = [];
  for (const height of [720, 1080]) {
    await page.setViewportSize({ width: 1280, height });
    const emptyBox = await empty.boundingBox();
    if (!emptyBox) throw new Error('无法测量空态引导');
    expect(emptyBox.height).toBeLessThanOrEqual(240);
    bounds.push(emptyBox);
  }
  expect(Math.abs(bounds[0]!.y - bounds[1]!.y)).toBeLessThanOrEqual(2);
  await page.screenshot({ path: info.outputPath('empty-directory.png'), animations: 'disabled' });
});
test('英文深色与超宽屏保留工具、网格和无障碍', async ({ page }, info) => {
  await page.getByRole('button', { name: '当前用户', exact: true }).click();
  await page.getByRole('menuitem', { name: /^主题 / }).click();
  await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
  await page.getByRole('button', { name: '当前用户', exact: true }).click();
  await page.getByRole('menuitem', { name: '语言 简体中文', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'English', exact: true }).click();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await noHorizontalOverflow(page);
  await expect(page.getByRole('button', { name: 'Current user', exact: true })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath('wide-dark-english.png') });
});

// 固定项使用真实服务端引用，不能用注入假DOM来证明滚动区域有效。
test('F307：多个真实固定项独立滚动并可打开', async ({ page }, info) => {
  const folderIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);
  const mutatePin = async (targetId: string, action: 'add' | 'remove') =>
    page.evaluate(
      async ({ targetId, remove }) => {
        const csrf = (await (await fetch('/api/console/v1/auth/csrf')).json()) as { token: string };
        const pins = (await (await fetch('/api/console/v1/native/files/pins')).json()) as {
          revision: number;
          items: { id: string; targetId: string }[];
        };
        const pin = pins.items.find((item) => item.targetId === targetId);
        if (remove && !pin) return;
        const response = await fetch(
          '/api/console/v1/native/files/pins' + (remove ? '/' + encodeURIComponent(pin!.id) : ''),
          {
            method: remove ? 'DELETE' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token },
            body: JSON.stringify({
              revision: pins.revision,
              ...(remove ? {} : { targetKind: 'folder', targetId }),
            }),
          },
        );
        if (response.status !== 200) throw Error('Real pin operation failed: ' + response.status);
      },
      { targetId, remove: action === 'remove' },
    );
  const failures: unknown[] = [];
  try {
    for (let index = 0; index < 8; index++) {
      const folder = await create(page, '/folders', {
        parentId: fixture.empty,
        name: '固定滚动-' + suffix + '-' + index,
      });
      folderIds.push(folder.id);
      await mutatePin(folder.id, 'add');
    }
    await page.reload();
    const region = page.locator('[data-file-pins-region]');
    const last = region.getByRole('link', { name: '固定滚动-' + suffix + '-7', exact: true });
    await expect(last).toBeVisible();
    await expect
      .poll(() => region.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    await last.scrollIntoViewIfNeeded();
    await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole('region', { name: '存储空间', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.screenshot({ path: info.outputPath('pinned-links-scroll.png') });
    await last.click();
    await expect(page).toHaveURL(new RegExp('parent=' + folderIds.at(-1)));
  } catch (error) {
    failures.push(error);
  }
  for (const id of folderIds) {
    try {
      await mutatePin(id, 'remove');
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '固定项验证或清理失败');
});
