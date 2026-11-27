import { readPreviewAccess } from './reading-fixture';
import { expect, test, type Page } from './preview-test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function login(page: Page) {
  const access = JSON.parse(
    await readFile(resolve(__dirname, readPreviewAccess().path), 'utf8'),
  ) as {
    username: string;
    password: string;
  };
  await page.goto('/login?returnTo=%2Fhome');
  await page.getByLabel('邮箱', { exact: true }).fill(access.username);
  await page.getByLabel('密码', { exact: true }).fill(access.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('button', { name: '新建', exact: true })).toBeEnabled();
}

test('Material 导航按任务分组，真实路由保留选中语义与原生链接', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await expect(page.getByRole('button', { name: '收起文件导航', exact: true })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: '我的文件', exact: true });
  const geometry = await navigation.locator('.ui-navigation-item').evaluateAll((items) =>
    items.map((item) => {
      const icon = item.querySelector('.ui-navigation-item-icon')!.getBoundingClientRect();
      const text = item.querySelector('.ui-navigation-item-label')!.getBoundingClientRect();
      return {
        x: icon.x,
        iconCenter: icon.y + icon.height / 2,
        textCenter: text.y + text.height / 2,
      };
    }),
  );
  expect(geometry.length).toBeGreaterThan(5);
  expect(
    Math.max(...geometry.map((item) => item.x)) - Math.min(...geometry.map((item) => item.x)),
  ).toBeLessThan(1);
  expect(geometry.every((item) => Math.abs(item.iconCenter - item.textCenter) < 1)).toBe(true);
  const collapse = await page
    .getByRole('button', { name: '收起文件导航', exact: true })
    .boundingBox();
  expect(collapse?.width).toBe(44);
  expect(collapse?.height).toBe(44);

  await expect(navigation.getByRole('heading', { name: '文件', exact: true })).toBeVisible();
  for (const [group, label, path] of [
    ['协作', '我的分享', 'shares'],
    ['传输与任务', '传输中心', 'transfers'],
  ] as const) {
    const link = navigation
      .getByRole('region', { name: group, exact: true })
      .getByRole('link', { name: label, exact: true });
    await expect(link).toHaveAttribute('href', '/home/' + path);
    await link.click();
    await expect(page).toHaveURL(new RegExp('/home/' + path + '$'));
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('main')).toHaveCount(1);
  }
  await navigation.getByRole('link', { name: '我的文件', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  const sidebar = page.locator('.surface-file-sidebar');
  const header = page.locator('[data-workspace-header]');
  const create = sidebar.getByRole('button', { name: '新建', exact: true });
  await expect(header.getByRole('button', { name: '新建', exact: true })).toHaveCount(0);
  await expect(create.getByText('新建', { exact: true })).toBeVisible();
  const shape = await create.evaluate((button) => getComputedStyle(button).borderRadius);
  expect(parseFloat(shape)).toBeGreaterThanOrEqual(20);
  await create.click();
  await expect(page.getByRole('menuitem', { name: '创建文件夹', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(create).toBeFocused();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath('material-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: '收起文件导航', exact: true }).click();
  await expect(create).toBeVisible();
  await expect(create.getByText('新建', { exact: true })).toHaveCount(0);
  await create.press('Enter');
  const folder = page.getByRole('menuitem', { name: '创建文件夹', exact: true });
  await expect(folder).toBeVisible();
  await page.setViewportSize({ width: 767, height: 900 });
  await expect(folder).toHaveCount(0);
  const mobileCreate = header.getByRole('button', { name: '新建', exact: true });
  await expect(mobileCreate).toBeVisible();
  await expect(page.getByRole('button', { name: '新建', exact: true })).toHaveCount(1);
  await mobileCreate.press('Enter');
  await expect(folder).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(mobileCreate).toBeFocused();
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(create).toBeVisible();
  await expect(mobileCreate).toHaveCount(0);
  await expect(page.getByRole('button', { name: '展开文件导航', exact: true })).toBeVisible();
});

test('移动抽屉导航返回文件焦点，内容不横向溢出', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(
    page.locator('[data-workspace-header]').getByRole('button', { name: '新建', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '文件导航', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '文件导航', exact: true });
  await expect(drawer.getByRole('heading', { name: '协作', exact: true })).toBeVisible();
  await drawer.getByRole('link', { name: '图片', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(/category=image/);
  await expect(page.getByRole('main')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath('material-mobile.png'), fullPage: true });
});

test('系统暗色主题覆盖内容与弹层，保留对比度和焦点', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await login(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '创建文件夹', exact: true })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath('material-dark.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '新建', exact: true })).toBeFocused();
});

for (const width of [320, 390]) {
  test(`手机 ${width}px 使用独立导航和内容优先布局`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await login(page);
    const destinations = page.getByRole('navigation', { name: '主要目的地', exact: true });
    await expect(destinations).toBeVisible();
    await expect(destinations.getByRole('link', { name: '全部文件', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('[data-file-workspace] .surface-masthead')).toBeHidden();
    const header = page.locator('[data-workspace-header]');
    const search = header.getByRole('searchbox', { name: '搜索文件', exact: true });
    const [headerBox, accountBox, searchBox] = await Promise.all([
      header.boundingBox(),
      header.getByRole('button', { name: '当前用户', exact: true }).boundingBox(),
      search.boundingBox(),
    ]);
    expect(headerBox?.height).toBe(112);
    if (!accountBox || !searchBox) throw Error('无法测量移动端顶栏');
    expect(searchBox.y).toBeGreaterThanOrEqual(accountBox.y + accountBox.height);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
      true,
    );
    const collection = page.locator('.surface-file-collection');
    const directory = collection.getByRole('heading', { level: 1 });
    await expect(directory).toBeVisible();
    const [toolbar, path, controls] = await Promise.all([
      collection.getByRole('toolbar').boundingBox(),
      directory.boundingBox(),
      collection.locator('[data-file-collection-actions]').boundingBox(),
    ]);
    if (!toolbar || !path || !controls) throw Error('无法测量移动端文件集合');
    expect(toolbar.height).toBeLessThanOrEqual(96);
    expect(controls.y).toBeGreaterThanOrEqual(path.y + path.height);
    await search.click();
    await expect(search).toBeFocused();
    await destinations.getByRole('button', { name: '分类', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '文件导航', exact: true });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('link', { name: '图片', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(/category=image/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('mobile-content.png') });
    await destinations.getByRole('link', { name: '传输中心', exact: true }).click();
    await expect(page).toHaveURL(/\/home\/transfers$/);
    expect((await header.boundingBox())?.height).toBe(56);
    await expect(search).toBeHidden();
    await expect(destinations.getByRole('link', { name: '传输中心', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await destinations.getByRole('link', { name: '全部文件', exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);
    await search.click();
    await expect(search).toBeFocused();
    await search.fill('未提交查询');
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(page.locator('#main-content')).toBeFocused();
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: '外观', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '主题模式', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '强调色', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '主要目的地', exact: true })).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
    await page.screenshot({ path: info.outputPath('mobile-settings.png') });
  });
}

test('侧栏展开和收缩在短屏保持图标列与正方形按钮对齐', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  const sidebar = page.locator('.surface-file-sidebar');
  const expand = page.getByRole('button', { name: '展开文件导航', exact: true });
  if (await expand.isVisible()) await expand.click();
  for (const height of [1000, 600]) {
    await page.setViewportSize({ width: 1440, height });
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(256);
    const expanded = await sidebar
      .locator('.ui-navigation-item-icon')
      .evaluateAll((icons) => icons.map((icon) => icon.getBoundingClientRect().x));
    expect(Math.max(...expanded) - Math.min(...expanded)).toBeLessThan(1);
    const collapse = page.getByRole('button', { name: '收起文件导航', exact: true });
    const button = await collapse.boundingBox();
    expect(button?.width).toBe(44);
    expect(button?.height).toBe(44);
    await collapse.click();
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(80);
    const rail = await sidebar.locator('.ui-navigation-item-icon').evaluateAll((icons) =>
      icons.map((icon) => {
        const bounds = icon.getBoundingClientRect();
        return bounds.x + bounds.width / 2;
      }),
    );
    const toggle = await expand.boundingBox();
    expect(rail.every((x) => Math.abs(x - (toggle!.x + toggle!.width / 2)) < 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`rail-${height}.png`) });
    await expand.click();
  }
});

test('类型目的地在非文件页也可用 Tab 和 Enter 到达', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await page.getByRole('link', { name: '传输中心', exact: true }).click();
  await expect(page).toHaveURL(/\/home\/transfers$/);
  const types = page.getByRole('button', { name: '按文件类型浏览', exact: true });
  await page.getByRole('button', { name: /^上传队列/ }).press('Tab');
  await expect(types).toBeFocused();
  await types.press('Enter');
  const images = page.getByRole('menuitemradio', { name: '图片', exact: true });
  await images.press('Enter');
  await expect(page).toHaveURL(/category=image/);
  await types.press('Enter');
  await expect(images).toHaveAttribute('aria-checked', 'true');
});
