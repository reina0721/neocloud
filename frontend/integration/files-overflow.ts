import { expect, type Page } from '@playwright/test';

export async function verifyFilesOverflow(page: Page) {
  const fixture = await page.evaluate(async () => {
    const base = '/api/console/v1';
    const csrf = await fetch(base + '/auth/csrf', { cache: 'no-store' });
    if (!csrf.ok) throw new Error('验收 CSRF HTTP ' + csrf.status);
    const { token } = (await csrf.json()) as { token: string };
    const post = async (path: string, body: unknown) => {
      const response = await fetch(base + '/native/files' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(path + ' HTTP ' + response.status);
      return (await response.json()) as { id: string };
    };
    const folder = await post('/folders', { name: '超限验收目录', parentId: '' });
    for (let index = 0; index < 12; index++) {
      await post('/folders', { name: '保留目录 ' + index, parentId: folder.id });
    }
    const item = await post('/text', {
      name: '待清理条目.txt',
      parentId: folder.id,
      text: 'test-bytes',
      key: crypto.randomUUID(),
    });
    await post('/' + item.id + '/trash', {});
    return { folder: folder.id };
  });

  const rejectedSearch = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/console/v1/native/files' && Boolean(url.searchParams.get('search'))
    );
  });
  await page.goto('/home?parent=' + fixture.folder + '&search=keep');
  expect((await rejectedSearch).status()).toBe(413);
  await expect(page.getByText('账号条目过多，无法完成这次检索。')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page).not.toHaveURL(/search=/);
  await expect(page.getByRole('button', { name: '保留目录 11', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '回收站', exact: true }).click();
  await page.getByRole('button', { name: '待清理条目.txt 的操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '永久删除', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '永久删除', exact: true });
  await expect(confirm).toContainText('将删除 1 项');
  await expect(confirm).toContainText('10 B');
  await confirm.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByText('回收站为空', { exact: true })).toBeVisible();
  await page.goto('/home?parent=' + fixture.folder);
  await expect(page.getByRole('button', { name: '保留目录 11', exact: true })).toBeVisible();
}
