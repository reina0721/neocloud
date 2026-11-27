import { expect, test, type Locator } from './preview-test';
import {
  editReadingFixtureText,
  openReadingFixtureFolder,
  readPreviewAccess,
} from './reading-fixture';

async function expectDesktopReadingColumn(preview: Locator) {
  await expect(preview).toBeVisible();
  const { width, centerOffset } = await preview.evaluate((article) => {
    const area = article.closest('[role="dialog"]')?.getBoundingClientRect();
    if (!area) throw new Error('Markdown reading workspace is missing');
    const paper = article.getBoundingClientRect();
    return {
      width: paper.width,
      centerOffset: Math.abs(paper.left + paper.width / 2 - area.left - area.width / 2),
    };
  });
  expect(width).toBeGreaterThan(600);
  expect(width).toBeLessThanOrEqual(768);
  expect(centerOffset).toBeLessThanOrEqual(12);
}

async function expectFittedImage(image: Locator) {
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(1440);
  const bounds = await image.evaluate((node) => {
    const image = node as HTMLImageElement;
    const article = image.closest('article')?.getBoundingClientRect();
    if (!article) throw new Error('Markdown preview is missing');
    const picture = image.getBoundingClientRect();
    return {
      width: picture.width,
      available: article.width,
      imageRatio: picture.width / picture.height,
      naturalRatio: image.naturalWidth / image.naturalHeight,
    };
  });
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.width).toBeLessThanOrEqual(bounds.available);
  expect(bounds.imageRatio).toBeCloseTo(bounds.naturalRatio, 2);
}

test('私有 Markdown 创建、渲染、编辑和安全图片', async ({ page }, info) => {
  const account = readPreviewAccess();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/login?returnTo=%2Fhome');
  await page.getByLabel('邮箱', { exact: true }).fill(account.username);
  await page.getByLabel('密码', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await openReadingFixtureFolder(page, 'Markdown验收-');

  let externalRequests = 0;
  await page.route('https://markdown.example.test/**', async (route) => {
    externalRequests++;
    await route.abort('failed');
  });
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1440;
    canvas.height = 720;
    const drawing = canvas.getContext('2d')!;
    drawing.fillStyle = '#eaf0fc';
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    drawing.fillStyle = '#4666aa';
    drawing.fillRect(100, 120, 510, 480);
    drawing.fillRect(830, 120, 510, 480);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('menuitem', { name: '上传文件', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '使用此位置', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: '书页 图.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image, 'base64'),
  });
  const queue = page.getByRole('dialog', { name: '上传队列', exact: true });
  await expect(queue.getByText('上传完成', { exact: true })).toBeVisible();
  await queue.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建 Markdown', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '使用此位置', exact: true }).click();
  const creation = page.getByRole('dialog', { name: '新建 Markdown', exact: true });
  await creation.getByLabel('名称', { exact: true }).fill('项目笔记.MARKDOWN');
  const source = [
    '# 项目笔记',
    '',
    '需要强调与 *斜体*，以及 ~~旧版~~。',
    '',
    '- 普通项目',
    '- [x] 已完成',
    '',
    '| 字段 | 状态 |',
    '| ---- | ---- |',
    '| 构建 | 已完成 |',
    '',
    '```text',
    'build OK',
    '```',
    '',
    '![书页示意](./书页%20图.png)',
    '',
    '![外部图替代](https://markdown.example.test/pixel.png)',
    '![越界图替代](../书页%20图.png)',
    '',
    '[可用网址](https://example.com/) [危险网址](javascript:alert%281%29)',
    '',
    '<script>window.markdownScriptRan = true;</script>',
    '<img src="https://markdown.example.test/raw.png">',
  ].join('\n');
  const input = creation.getByLabel('文件内容', { exact: true });
  await input.fill(source);
  await input.evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    const start = field.value.indexOf('需要强调');
    field.setSelectionRange(start, start + '需要强调'.length);
  });
  await creation.getByRole('button', { name: '粗体', exact: true }).click();
  await expect(input).toHaveValue(source.replace('需要强调', '**需要强调**'));
  const preview = creation.getByRole('article', { name: '预览', exact: true });
  await expect(preview.getByRole('heading', { name: '项目笔记', exact: true })).toBeVisible();
  await expect(preview.locator('strong')).toHaveText('需要强调');
  await expect(preview.locator('em')).toHaveText('斜体');
  await expect(preview.locator('del')).toHaveText('旧版');
  await expect(preview.getByRole('checkbox')).toBeChecked();
  await expect(preview.getByRole('table')).toContainText('构建');
  await expect(preview.locator('pre code')).toContainText('build OK');
  const cover = preview.getByRole('img', { name: '书页示意', exact: true });
  await expect
    .poll(() => cover.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(cover).toHaveAttribute('src', /^blob:/);
  await expect(preview.getByText('外部图替代')).toBeVisible();
  await expect(preview.getByText('越界图替代')).toBeVisible();
  await expect(preview.getByRole('link', { name: '危险网址', exact: true })).toHaveCount(0);
  await expect(preview.getByRole('link', { name: '可用网址', exact: true })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await expect(preview.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => 'markdownScriptRan' in window)).toBe(false);
  expect(externalRequests).toBe(0);
  await input.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: info.outputPath('markdown-desktop.png') });
  await creation.getByRole('button', { name: '保存', exact: true }).click();
  await expect(creation).toHaveCount(0);

  const name = '项目笔记.MARKDOWN';
  const item = page.getByRole('button', { name, exact: true });
  const directoryUrl = new URL(page.url());
  await item.click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  const quick = dialog.getByRole('article', { name: 'Markdown 预览', exact: true });
  await expect(quick.locator('strong')).toHaveText('需要强调');
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === directoryUrl.pathname &&
      url.searchParams.get('parent') === directoryUrl.searchParams.get('parent') &&
      url.searchParams.has('preview'),
  );
  await expect(quick.getByRole('img', { name: '书页示意', exact: true })).toHaveAttribute(
    'src',
    /^blob:/,
  );
  await expect(quick.getByText('外部图替代')).toBeVisible();
  await expect(quick.getByRole('link', { name: '危险网址', exact: true })).toHaveCount(0);
  await expect(quick.locator('script')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('quick-markdown-desktop.png'),
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: '查看源码', exact: true }).click();
  await expect(dialog.locator('[data-file-text-preview] pre')).toContainText('# 项目笔记');
  await dialog.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page).toHaveURL(/\/home\/view\?.*\bapp=markdown\b/);
  await page.setViewportSize({ width: 1920, height: 960 });
  await dialog.getByRole('button', { name: '并排', exact: true }).click();
  const splitInput = await dialog.getByLabel('文件内容', { exact: true }).boundingBox();
  const splitPreview = await dialog
    .getByRole('article', { name: '预览', exact: true })
    .boundingBox();
  expect(splitInput!.x + splitInput!.width).toBeLessThan(splitPreview!.x);
  const previewMode = dialog.getByRole('button', { name: '预览', exact: true });
  const previewModeBefore = (await previewMode.boundingBox())!;
  await previewMode.click();
  expect(Math.abs((await previewMode.boundingBox())!.x - previewModeBefore.x)).toBeLessThanOrEqual(
    1,
  );
  const savedPreview = dialog.getByRole('article', { name: '预览', exact: true });
  await expect(savedPreview.locator('strong')).toHaveText('需要强调');
  await expectDesktopReadingColumn(savedPreview);
  await expectFittedImage(savedPreview.getByRole('img', { name: '书页示意', exact: true }));
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('文件内容', { exact: true })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载', exact: true }).click();
  expect((await download).suggestedFilename()).toBe(name);

  const direct = await page.context().newPage();
  try {
    await direct.setViewportSize({ width: 1920, height: 960 });
    await direct.goto(page.url());
    const directDialog = direct.getByRole('dialog', { name, exact: true });
    await expect(directDialog.getByRole('button', { name: '预览', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const directPreview = directDialog.getByRole('article', { name: '预览', exact: true });
    await expectDesktopReadingColumn(directPreview);
    await expectFittedImage(directPreview.getByRole('img', { name: '书页示意', exact: true }));
    await direct.screenshot({
      path: info.outputPath('markdown-workspace-wide.png'),
      animations: 'disabled',
    });
  } finally {
    await direct.close();
  }

  await page.setViewportSize({ width: 320, height: 760 });
  await expect(dialog.getByRole('button', { name: '并排', exact: true })).toHaveCount(0);
  await expect
    .poll(() => dialog.evaluate((node) => node.scrollWidth <= node.clientWidth))
    .toBe(true);
  await expectFittedImage(savedPreview.getByRole('img', { name: '书页示意', exact: true }));
  await page.screenshot({ path: info.outputPath('markdown-mobile.png') });
  await dialog.getByRole('button', { name: '源码', exact: true }).click();
  const savedInput = dialog.getByLabel('文件内容', { exact: true });
  await savedInput.fill('临时修改');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const discard = page.getByRole('dialog', { name: '放弃未保存的 Markdown 修改？', exact: true });
  await discard.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(savedInput).toHaveValue('临时修改');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await discard.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await editReadingFixtureText(page, name);
  await dialog.getByRole('button', { name: '预览', exact: true }).click();
  await expect(savedPreview.locator('strong')).toHaveText('需要强调');
  await dialog.getByRole('button', { name: '源码', exact: true }).click();
  await savedInput.fill('# 一行笔记');
  await dialog.getByRole('button', { name: '预览', exact: true }).click();
  await expect(savedPreview.getByRole('heading', { name: '一行笔记', exact: true })).toBeVisible();
  expect((await savedPreview.boundingBox())!.height).toBeLessThan(160);
  await dialog.getByRole('button', { name: '源码', exact: true }).click();
  await savedInput.fill('x'.repeat(256 * 1024 + 1));
  await dialog.getByRole('button', { name: '预览', exact: true }).click();
  await expect(savedPreview.getByRole('status')).toContainText('超出渲染大小限制');
  await dialog.getByRole('button', { name: '源码', exact: true }).click();
  await savedInput.fill('x'.repeat(1024 * 1024 + 1));
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await discard.getByRole('button', { name: '放弃修改', exact: true }).click();
  expect(externalRequests).toBe(0);

  await page.setViewportSize({ width: 1920, height: 960 });
  await page.getByRole('button', { name: name + ' 的操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '打开方式', exact: true }).click();
  await page
    .getByRole('dialog', { name: '打开方式', exact: true })
    .getByRole('button', { name: 'Markdown 编辑器', exact: true })
    .click();
  await expect(page).toHaveURL(/\/home\/view\?.*\bapp=markdown\b/);
  await expectDesktopReadingColumn(savedPreview);
});
