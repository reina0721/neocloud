import { expect, test } from '@playwright/test';
import { readPreviewAccess } from './reading-fixture';

test('资料保存失败保留草稿，账号偏好通过个人设置编辑和重试', async ({ page }, info) => {
  const access = readPreviewAccess();
  let writes = 0;
  for (const resource of ['profile', 'preferences']) {
    await page.route(`**/native/iam/self/${resource}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      writes += 1;
      await route.fulfill({ status: 503, json: {} });
    });
  }
  await page.goto('/login?returnTo=%2Faccount');
  await page.getByLabel('邮箱', { exact: true }).fill(access.username);
  await page.getByLabel('密码', { exact: true }).fill(access.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const profile = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '扩展资料', exact: true }) });
  const settings = page.getByRole('link', { name: '前往外观与偏好设置', exact: true });
  await expect(profile.getByLabel('扩展资料', { exact: true })).toBeVisible();
  await expect(settings).toBeVisible();
  await profile.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '扩展资料', exact: true });
  const nickname = editor.getByLabel('昵称', { exact: true });
  const original = await nickname.inputValue();
  await nickname.fill('未保存的资料');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await profile.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(nickname).toHaveValue(original);
  await nickname.fill('保存失败的资料');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor.getByRole('alert')).toBeVisible();
  await expect(nickname).toHaveValue('保存失败的资料');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await settings.click();
  await expect(page).toHaveURL(/\/settings$/);
  const theme = page.getByRole('radiogroup', { name: '主题模式', exact: true });
  const dark = theme.getByRole('radio', { name: '深色主题', exact: true });
  const name = (await dark.isChecked()) ? '浅色主题' : '深色主题';
  await theme.getByText(name, { exact: true }).click();
  await expect(page.getByText('账户偏好未同步', { exact: true })).toBeVisible();
  await expect(theme.getByRole('radio', { name, exact: true })).toBeChecked();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => writes).toBe(3);
  await expect(page.getByText('账户偏好未同步', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '放弃未同步更改', exact: true }).click();
  await expect(theme.getByRole('radio', { name, exact: true })).not.toBeChecked();
  await page.setViewportSize({ width: 320, height: 760 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await theme.screenshot({
    path: info.outputPath('account-preferences-settings.png'),
    animations: 'disabled',
  });
});
