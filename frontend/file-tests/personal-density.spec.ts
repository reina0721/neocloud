import { expect, test } from './preview-test';
import { readPreviewAccess } from './reading-fixture';

test('个人设置在桌面与窄屏保持紧凑，并能用键盘保存主题和定位设置', async ({ page }, info) => {
  const access = readPreviewAccess();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/login?returnTo=%2Fsettings');
  await page.getByLabel('邮箱', { exact: true }).fill(access.username);
  await page.getByLabel('密码', { exact: true }).fill(access.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);

  const theme = page.getByRole('radiogroup', { name: '主题模式', exact: true });
  const section = page.locator('main section').filter({ has: theme });
  const measures: { width: number; sectionTop: number }[] = [];
  for (const viewport of [
    { width: 1440, height: 900, firstGroupTop: 185 },
    { width: 390, height: 844, firstGroupTop: 220 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await expect(theme.getByRole('radio')).toHaveCount(3);
    await expect
      .poll(async () => (await section.boundingBox())?.y ?? Infinity)
      .toBeLessThanOrEqual(viewport.firstGroupTop);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    measures.push({ width: viewport.width, sectionTop: (await section.boundingBox())!.y });
    await page.screenshot({
      path: info.outputPath(`personal-density-${viewport.width}.png`),
      animations: 'disabled',
    });
  }

  const light = theme.getByRole('radio', { name: '浅色主题', exact: true });
  const dark = theme.getByRole('radio', { name: '深色主题', exact: true });
  await expect(light).toBeEnabled();
  await light.focus();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/native/iam/self/preferences') &&
      response.request().method() === 'PATCH' &&
      response.ok(),
  );
  await light.press('ArrowRight');
  await expect(dark).toBeChecked();
  await saved;
  await page.reload();
  await expect(dark).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({
    path: info.outputPath('personal-density-390-dark.png'),
    animations: 'disabled',
  });

  const search = page.getByRole('searchbox', { name: '搜索设置项', exact: true });
  await search.fill('时区');
  await page.getByRole('link', { name: '时区', exact: true }).press('Enter');
  await expect(page).toHaveURL(/\/settings\/locale#settings-localeRegion-timeZone$/);
  await expect(page.getByRole('combobox', { name: '时区', exact: true })).toBeFocused();
  await expect(search).toHaveValue('时区');
  await info.attach('personal-density.json', {
    body: JSON.stringify(measures, null, 2),
    contentType: 'application/json',
  });
});
