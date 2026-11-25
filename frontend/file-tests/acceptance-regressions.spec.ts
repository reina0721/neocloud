import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from './preview-test';
import { readPreviewAccess } from './reading-fixture';

// 完整 Chromium 将站点通知权限反映到 Notification.permission。
test.use({ channel: 'chromium' });

async function login(page: Page, target: string) {
  const { username, password } = readPreviewAccess();
  await page.goto('/login?' + new URLSearchParams({ returnTo: target }).toString());
  await page.getByLabel('邮箱', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(target);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
}

test('个人姓名草稿保护鼠标和键盘返回文件', async ({ page }) => {
  await login(page, '/account');
  const name = page.getByLabel('姓名', { exact: true });
  const original = await name.inputValue();
  const back = page.getByRole('link', { name: '返回我的文件', exact: true });
  const confirmation = page
    .getByRole('alertdialog')
    .filter({ has: page.getByRole('heading', { name: '离开当前页面？', exact: true }) });
  const draft = '待核对-' + randomUUID().slice(0, 8);
  await name.fill(draft);
  await back.click();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(name).toHaveValue(draft);
  await expect(back).toBeFocused();
  await back.press('Enter');
  await confirmation.getByRole('button', { name: '离开', exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await page.goto('/account');
  await expect(name).toHaveValue(original);
  await name.fill(draft);
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByText('个人资料已保存', { exact: true })).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(/\/home$/);
  await page.goto('/account');
  await expect(name).toHaveValue(draft);
  await name.fill(original);
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByText('个人资料已保存', { exact: true })).toBeVisible();
  await page.goto('/settings/actions');
  await page.getByRole('switch', { name: '离开未保存内容时提醒', exact: true }).click();
  await page.goto('/account');
  await name.fill(draft);
  await back.click();
  await expect(page).toHaveURL(/\/home$/);
});

test('错误旧密码保留有效会话和新密码，真正失效仍跳转', async ({ page }) => {
  await login(page, '/account');
  const current = page.getByLabel('当前密码', { exact: true });
  const next = page.getByLabel('新密码', { exact: true });
  const attempted = 'VfA!' + randomUUID();
  await current.fill('VfA!' + randomUUID());
  await next.fill(attempted);
  const submit = page.getByRole('button', { name: '修改密码', exact: true });
  const rejected = page.waitForResponse((response) => response.url().endsWith('/auth/password'));
  await submit.click();
  expect((await rejected).status()).toBe(401);
  await expect(page.getByText('请检查当前密码是否正确。', { exact: true })).toBeVisible();
  await expect(current).toBeFocused();
  await expect(next).toHaveValue(attempted);
  await expect(page).toHaveURL(/\/account$/);
  expect(
    await page.evaluate(async () => (await fetch('/api/console/v1/auth/session')).status),
  ).toBe(200);
  const logout = await page.evaluate(async () => {
    const prefix = '/api/console/v1/auth';
    const { token } = (await (await fetch(prefix + '/csrf')).json()) as { token: string };
    return (
      await fetch(prefix + '/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ logout: true }),
      })
    ).status;
  });
  expect(logout).toBe(204);
  await submit.click();
  await expect(page).toHaveURL(/\/session-expired(?:\?|$)/);
});

test('320 和 390 像素的中英主题选项可扫读和键盘切换', async ({ page }, info) => {
  await login(page, '/settings');
  for (const english of [false, true]) {
    if (english) {
      await page.goto('/settings/locale');
      const language = page.getByRole('radio', { name: 'English', exact: true });
      await expect(language).toBeEnabled();
      await language.check();
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const response = await fetch('/api/console/v1/native/iam/self/preferences', {
              cache: 'no-store',
            });
            return response.ok ? ((await response.json()) as { language: string }).language : null;
          }),
        )
        .toBe('en-US');
      await page.goto('/settings');
    }
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const mode = page.getByRole('radiogroup', {
        name: english ? 'Theme mode' : '主题模式',
        exact: true,
      });
      await expect(mode.getByRole('radio')).toHaveCount(3);
      const large = page.getByRole('radiogroup', {
        name: english ? 'Interface font size' : '界面字号',
        exact: true,
      });
      const enlarged = large.getByRole('radio', { name: english ? 'Large' : '大', exact: true });
      await enlarged.press('Space');
      const back = page.getByRole('link', {
        name: english ? 'Back to files' : '返回我的文件',
        exact: true,
      });
      const bell = page
        .getByRole('button', { name: english ? /^Notifications/ : /^通知(?:，|$)/ })
        .first();
      const [backBox, bellBox] = await Promise.all([back.boundingBox(), bell.boundingBox()]);
      expect(backBox && bellBox && backBox.x + backBox.width <= bellBox.x).toBe(true);
      for (const label of english
        ? ['Light theme', 'Dark theme', 'Follow system']
        : ['浅色主题', '深色主题', '跟随系统']) {
        const option = mode.getByRole('radio', { name: label, exact: true });
        await expect(option).toBeEnabled();
        await expect
          .poll(() =>
            mode.getByText(label, { exact: true }).evaluate((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              return range.getClientRects().length;
            }),
          )
          .toBeLessThanOrEqual(2);
        await option.press('Space');
        await expect(option).toBeChecked();
      }
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({
        path: info.outputPath(`theme-${english ? 'en' : 'zh'}-${width}.png`),
      });
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const response = await fetch('/api/console/v1/native/iam/self/preferences', {
              cache: 'no-store',
            });
            return response.ok
              ? ((await response.json()) as { themeMode: string }).themeMode
              : null;
          }),
        )
        .toBe('system');
      await page.reload();
      await expect(
        mode.getByRole('radio', { name: english ? 'Follow system' : '跟随系统', exact: true }),
      ).toBeChecked();
    }
  }
});

test('已打开的主题子菜单在偏好就绪后即时恢复', async ({ page }) => {
  let release!: () => void;
  const readiness = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/auth/access', async (route) => {
    if (route.request().method() === 'GET') await readiness;
    await route.continue();
  });
  const account = page.getByRole('button', { name: '当前用户', exact: true });
  const choice = page.getByRole('menuitem', { name: /^主题 / });
  const dark = page.getByRole('menuitemradio', { name: '深色', exact: true });
  try {
    await login(page, '/home');
    await account.click();
    await choice.click();
    await expect(dark).toBeDisabled();
    release();
    await expect(dark).toBeEnabled();
    await dark.press('Escape');
    await choice.press('ArrowRight');
    await expect(dark).toBeEnabled();
    await dark.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await account.click();
    await choice.click();
    await expect(dark).toHaveAttribute('aria-checked', 'true');
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const restoreAll of [false, true]) {
  test(`存储恢复后重试实际的${restoreAll ? '全部' : '单类'}默认值`, async ({ page }) => {
    await login(page, '/settings/data-display');
    const size = page.getByRole('combobox', { name: '默认每页数量', exact: true });
    await size.click();
    await page.getByRole('option', { name: '50', exact: true }).click();
    await expect(size).toHaveText('50');
    await page.evaluate(() => {
      const original = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')?.value as
        Storage['setItem'] | undefined;
      if (!original) throw new Error('Missing browser storage setter');
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key === 'clouddrive.shell')
          throw new DOMException('Fixture temporary quota error', 'QuotaExceededError');
        original.call(this, key, value);
      };
      window.addEventListener(
        'restore-fixture-storage',
        () => {
          Storage.prototype.setItem = original;
        },
        { once: true },
      );
    });
    await page
      .getByRole('button', { name: restoreAll ? '恢复全部默认' : '恢复默认', exact: true })
      .click();
    await page.getByRole('alertdialog').getByRole('button', { name: '恢复', exact: true }).click();
    await expect(size).toHaveText('20');
    await expect(page.getByText('未保存到此浏览器', { exact: true })).toBeVisible();
    if (restoreAll) await page.getByRole('link', { name: '外观与显示', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('restore-fixture-storage')));
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByText('未保存到此浏览器', { exact: true })).toHaveCount(0);
    await page.goto('/settings/data-display');
    await expect(size).toHaveText('20');
  });
}

test('偏好导入部分失败后重试该批设置并刷新读回', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page, '/settings/data-display');
  await page.getByRole('button', { name: '复制当前配置', exact: true }).click();
  const exported = await page.evaluate(() => navigator.clipboard.readText());
  const input = JSON.parse(exported) as {
    preferences: { dataDisplay: { pageSize: number }; notifications: { sound: boolean } };
  };
  input.preferences.dataDisplay.pageSize = 50;
  input.preferences.notifications.sound = true;
  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')
      ?.value as Storage['setItem'];
    let fail = true;
    Storage.prototype.setItem = function (key, value) {
      if (fail && this === localStorage && key === 'clouddrive.shell') {
        fail = false;
        throw new DOMException('Fixture temporary quota error', 'QuotaExceededError');
      }
      original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: '导入配置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入偏好配置', exact: true });
  await dialog.getByLabel('配置 JSON', { exact: true }).fill(JSON.stringify(input));
  await dialog.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.getByText('未保存到此浏览器', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('未保存到此浏览器', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('combobox', { name: '默认每页数量', exact: true })).toHaveText('50');
  await page.goto('/settings/notifications');
  await expect(page.getByRole('switch', { name: '播放提示音', exact: true })).toBeChecked();
});

for (const decision of ['granted', 'denied', 'unsupported'] as const) {
  test(`个人设置根据浏览器权限保存桌面通知 ${decision}`, async ({ page, context }, info) => {
    if (decision !== 'unsupported') {
      const session = await context.newCDPSession(page);
      const { targetInfo } = await session.send('Target.getTargetInfo');
      await session.send('Browser.setPermission', {
        origin: readPreviewAccess().origin,
        permission: { name: 'notifications' },
        setting: decision,
        browserContextId: targetInfo.browserContextId,
      });
    }
    if (decision === 'unsupported')
      await page.addInitScript(() => {
        Reflect.deleteProperty(window, 'Notification');
      });
    await login(page, '/settings/notifications');
    await expect
      .poll(() =>
        page.evaluate(() =>
          typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
        ),
      )
      .toBe(decision);
    const toggle = page.getByRole('switch', { name: '浏览器桌面通知', exact: true });
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    if (decision === 'granted') await toggle.click();
    else await toggle.press('Space');
    if (decision === 'granted') await expect(toggle).toBeChecked();
    else {
      await expect(toggle).not.toBeChecked();
      await page
        .getByRole('button', { name: /^通知(?:，|$)/ })
        .first()
        .click();
      await expect(page.getByText('无法开启浏览器桌面通知', { exact: true })).toHaveCount(1);
      await page.screenshot({ path: info.outputPath('desktop-notification-feedback.png') });
    }
    await page.reload();
    await expect(toggle).toBeChecked({ checked: decision === 'granted' });
    if (decision !== 'granted') {
      await page.getByRole('link', { name: '进入管理面板', exact: true }).click();
      await expect(page).toHaveURL(/\/workspace$/);
      await page
        .getByRole('button', { name: /^通知(?:，|$)/ })
        .first()
        .click();
      await expect(page.getByText('无法开启浏览器桌面通知', { exact: true })).toHaveCount(1);
    }
  });
}
