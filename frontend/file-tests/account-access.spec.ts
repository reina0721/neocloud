import { expect, test } from '@playwright/test';
import { readPreviewAccess } from './reading-fixture';

for (const scenario of [
  { name: '无本人资料读取权限', read: false, edit: false, password: false },
  { name: '仅可查看扩展资料', read: true, edit: false, password: false },
  { name: '可编辑扩展资料', read: true, edit: true, password: false },
  { name: '可改密但资料只读', read: true, edit: false, password: true },
]) {
  test(`个人账户操作范围：${scenario.name}`, async ({ page }) => {
    const access = readPreviewAccess();
    const nativePermissions = [
      ...(scenario.read ? ['iam:account:self:read'] : []),
      ...(scenario.edit ? ['iam:account:self:profile:write'] : []),
      ...(scenario.password ? ['iam:account:self:password:write'] : []),
    ];
    let profileReads = 0;
    await page.route('**/auth/access', async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const value = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: {
          ...value,
          permissions: scenario.edit ? ['account.update'] : [],
          nativePermissions,
        },
      });
    });
    await page.route('**/native/iam/self/profile', async (route) => {
      if (route.request().method() === 'GET') profileReads += 1;
      await route.continue();
    });

    await page.goto('/login?returnTo=%2Faccount');
    await page.getByLabel('邮箱', { exact: true }).fill(access.username);
    await page.getByLabel('密码', { exact: true }).fill(access.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByText('当前会话', { exact: true })).toBeVisible();

    const profile = page.getByLabel('扩展资料', { exact: true });
    await expect(profile).toHaveCount(scenario.read ? 1 : 0);
    if (scenario.read) await expect(profile).toBeVisible();
    await expect(page.getByRole('button', { name: '编辑', exact: true })).toHaveCount(
      scenario.edit ? 1 : 0,
    );
    await expect(page.getByLabel('当前密码', { exact: true })).toHaveCount(
      scenario.password ? 1 : 0,
    );
    // React 开发模式会重复运行读取 effect。这里只验证读取是否由权限启用。
    expect(profileReads > 0).toBe(scenario.read);
  });
}
