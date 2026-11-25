import { expect, test } from '@playwright/test';

/** 每个分类子路由应可达、PageHeader 为该分类标题、左导航对应项 active。 */
const CASES: ReadonlyArray<{
  path: string;
  heading: string;
  control: ReadonlyArray<{ kind: 'radiogroup' | 'switch' | 'select'; name: string | RegExp }>;
}> = [
  {
    path: '/settings',
    heading: '外观',
    control: [{ kind: 'radiogroup', name: '主题模式' }],
  },
  {
    path: '/settings/navigation',
    heading: '导航',
    control: [{ kind: 'switch', name: '记住展开的侧栏菜单' }],
  },
  {
    path: '/settings/data-display',
    heading: '数据展示',
    control: [{ kind: 'radiogroup', name: /表格密度|默认每页数量/ }],
  },
  {
    path: '/settings/actions',
    heading: '操作偏好',
    control: [{ kind: 'radiogroup', name: /编辑成功后去向|默认详情展示模式/ }],
  },
  {
    path: '/settings/locale',
    heading: '语言与地区',
    control: [{ kind: 'radiogroup', name: '界面语言' }],
  },
  {
    path: '/settings/notifications',
    heading: '通知',
    control: [{ kind: 'switch', name: '应用内通知' }],
  },
  {
    path: '/settings/accessibility',
    heading: '可访问性',
    control: [{ kind: 'switch', name: '增强焦点轮廓' }],
  },
  {
    path: '/settings/shortcuts',
    heading: '快捷键',
    control: [{ kind: 'switch', name: '启用快捷键' }],
  },
];

for (const entry of CASES) {
  test(`${entry.heading}独立页：${entry.path} 可达且左导航 active`, async ({ page }) => {
    await page.goto(entry.path);
    await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(entry.heading);
    for (const c of entry.control) {
      const locator =
        c.kind === 'radiogroup'
          ? page.getByRole('radiogroup', { name: c.name })
          : c.kind === 'switch'
            ? page.getByRole('switch', { name: c.name })
            : page.getByRole('combobox', { name: c.name });
      await expect(locator.first()).toBeVisible();
    }
    // 左导航当前项高亮。
    const nav = page.getByRole('navigation', { name: '个人中心导航' });
    await expect(nav.locator(`a[href="${entry.path}"]`)).toHaveAttribute('aria-current', 'page');
    // 刷新保持（独立 URL）。
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(entry.heading);
  });
}

test('个人导航可访问全部设置分类，且标记当前页', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  const nav = page.getByRole('navigation', { name: '个人中心导航' });
  await nav.getByRole('button', { name: '更多界面选项' }).click();
  for (const path of [...CASES.map((entry) => entry.path), '/settings/security']) {
    await expect(nav.locator(`a[href="${path}"]`)).toBeVisible();
  }
  await expect(nav.locator('a[href="/settings"]')).toHaveAttribute('aria-current', 'page');
  await nav.locator('a[href="/settings/navigation"]').click();
  await expect(page).toHaveURL(/\/settings\/navigation/);
});

test('内页壳持久化：切换分类不重建侧边栏，搜索输入与结果保留（SET-011）', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  const sidebar = page.getByRole('navigation', { name: '个人中心导航' });
  const search = page.getByRole('searchbox', { name: '搜索设置项' });
  await expect(search).toBeVisible();
  await search.fill('记住');
  // 切到另一分类：URL 变、标题变，但搜索输入保留（壳未重挂）。
  await sidebar.getByRole('button', { name: '更多界面选项' }).click();
  await sidebar.locator('a[href="/settings/navigation"]').click();
  await expect(page).toHaveURL(/\/settings\/navigation/);
  await expect(page.getByRole('heading', { level: 1, name: '导航' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '搜索设置项' })).toHaveValue('记住');
});

test('个人中心保持单侧导航与内容区搜索，分类项提供图标', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  const sidebar = page.getByRole('navigation', { name: '个人中心导航' });
  await expect(sidebar).toHaveCount(1);
  await expect(page.getByRole('main').getByRole('searchbox', { name: '搜索设置项' })).toBeVisible();
  await expect(sidebar.getByText('账户', { exact: true })).toBeVisible();
  await expect(sidebar.getByText('偏好设置', { exact: true })).toBeVisible();
  await sidebar.getByRole('button', { name: '更多界面选项' }).click();
  for (const { path } of CASES) {
    const item = sidebar.locator(`a[href="${path}"]`);
    await expect(item.locator('svg')).toBeVisible();
  }
  await expect(sidebar.locator('a[href="/settings"]')).toHaveAttribute('aria-current', 'page');
});

test('分类切换复用主 Shell route-enter 动效：内容区段淡入、壳静止（SET-012）', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  // 全局 hydration 完成时，设置内容仍可能在加载；等待真正的内容容器。
  await expect(page.locator('[data-route-content]')).toBeVisible();
  // 切到另一分类：动画采样期直接语义区段应命中 route-enter recipe，
  // 壳（PageHeader）opacity 恒 1（不参与 route-enter、不闪）。
  let sawFade = false;
  const shellOpacities: number[] = [];
  const sidebar = page.getByRole('navigation', { name: '个人中心导航' });
  await sidebar.getByRole('button', { name: '更多界面选项' }).click();
  await sidebar.locator('a[href="/settings/navigation"]').click();
  await expect(page).toHaveURL(/\/settings\/navigation/);
  await expect(page.getByRole('heading', { level: 1, name: '导航' })).toBeVisible();
  for (let i = 0; i < 40; i++) {
    const sample = await page.evaluate(() => {
      const content = document.querySelector('[data-route-content]');
      const stack = content?.querySelector(':scope > .surface-page-stack');
      const first = stack?.querySelector('[id^=settings-][data-reveal]');
      const header = document.querySelector('.surface-route-region');
      return {
        anim: first ? getComputedStyle(first).animationName : '',
        stackAnim: stack ? getComputedStyle(stack).animationName : '',
        op: header ? parseFloat(getComputedStyle(header).opacity) : -1,
      };
    });
    if (sample.anim.includes('surface-item-enter')) sawFade = true;
    expect(sample.stackAnim).toBe('none');
    shellOpacities.push(sample.op);
    await page.waitForTimeout(16);
  }
  expect(sawFade).toBe(true);
  expect(Math.min(...shellOpacities)).toBeGreaterThan(0.99);
});
