import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readPreviewAccess } from './reading-fixture';

const files = '/api/console/v1/native/files';
test.use({ hasTouch: true });

async function login(page: Page) {
  const access = readPreviewAccess();
  await page.goto('/login?returnTo=%2Fhome');
  await page.getByLabel('邮箱', { exact: true }).fill(access.username);
  await page.getByLabel('密码', { exact: true }).fill(access.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function createEntry(page: Page, kind: 'folders' | 'text', name: string, parentId = '') {
  const { status, id } = await page.evaluate(
    async ({ url, data }) => {
      const { token } = (await (
        await fetch('/api/console/v1/auth/csrf', { cache: 'no-store' })
      ).json()) as { token: string };
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify(data),
      });
      return { status: response.status, id: ((await response.json()) as { id?: string }).id };
    },
    {
      url: files + '/' + kind,
      data: { name, parentId, ...(kind === 'text' ? { text: 'P1 QA', key: randomUUID() } : {}) },
    },
  );
  expect(status, 'Create isolated fixture: ' + kind).toBe(200);
  expect(id).toBeTruthy();
  return { name, id: String(id) };
}

async function expectToolbarHits(toolbar: Locator) {
  await expect
    .poll(() =>
      toolbar.evaluate((element) =>
        [...element.querySelectorAll<HTMLElement>('button,input[type=checkbox]')]
          .filter((control) => control.getClientRects().length && !control.matches(':disabled'))
          .flatMap((control) => {
            const { x, y, width, height } = control.getBoundingClientRect();
            const hit = document.elementFromPoint(x + width / 2, y + height / 2);
            return control.contains(hit) ||
              (control instanceof HTMLInputElement && control.parentElement?.contains(hit))
              ? []
              : [control.getAttribute('aria-label') || control.textContent];
          }),
      ),
    )
    .toEqual([]);
}

function requestGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('V-01 窄屏路径、工具命中和更多菜单保持可用', async ({ page, context }, info) => {
  await login(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const root = await createEntry(page, 'folders', '工具栏-' + randomUUID().slice(0, 8));
  const child = await createEntry(page, 'folders', '第二层-用于验证目录路径', root.id);
  const leaf = await createEntry(
    page,
    'folders',
    '第三层-这个较长的目录名称必须保留可见的当前路径',
    child.id,
  );
  const entry = await createEntry(page, 'text', '示例.txt', leaf.id);
  const toolbar = page.getByRole('toolbar', { name: leaf.name, exact: true });
  const more = toolbar.getByRole('button', { name: /^更多(?:目录)?操作$/ });
  await page.goto('/home?parent=' + leaf.id);
  await expect(page.locator('[data-file-item="' + entry.id + '"]')).toBeVisible();

  for (const width of [320, 390, 713, 800]) {
    await page.setViewportSize({ width, height: 844 });
    const currentPath = toolbar.getByRole('heading', { name: leaf.name, exact: true });
    await expect(currentPath).toBeVisible();
    expect((await currentPath.boundingBox())?.width).toBeGreaterThan(76);
    await expectToolbarHits(toolbar);
    await toolbar.getByRole('button', { name: '完整目录路径', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: root.name, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(toolbar.getByRole('button', { name: '完整目录路径', exact: true })).toBeFocused();
    await more.press('Enter');
    await expect(page.getByRole('menuitem', { name: '刷新', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    await page.screenshot({ path: info.outputPath('V-01-' + width + '.png') });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await toolbar.getByRole('button', { name: '视图', exact: true }).tap();
  await expect(page.getByRole('menuitemradio', { name: '列表', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('checkbox', { name: '选择本页全部项目' }).check();
  await expectToolbarHits(toolbar);
  await expect(page.getByText('已选择 1 项', { exact: true })).toBeVisible();
  await more.click();
  await page.getByRole('menuitem', { name: '取消选择', exact: true }).click();
  await expect(page.getByText('已选择 1 项', { exact: true })).toHaveCount(0);
  await more.click();
  await page.getByRole('menuitem', { name: '复制当前路径', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    '/' + [root.name, child.name, leaf.name].join('/'),
  );
  await more.click();
  await page.getByRole('menuitem', { name: '高级搜索', exact: true }).click();
  const advancedSearch = page.getByRole('dialog', { name: '高级搜索', exact: true });
  await expect(advancedSearch).toBeVisible();
  await advancedSearch.getByRole('button', { name: '取消', exact: true }).click();
  await expect(advancedSearch).toBeHidden();
  await more.click();
  await page.getByRole('menuitemradio', { name: '大小', exact: true }).click();
  await more.click();
  await expect(page.getByRole('menuitemradio', { name: '大小', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const refresh = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === files,
  );
  await page.getByRole('menuitem', { name: '刷新', exact: true }).click();
  expect((await refresh).ok()).toBe(true);

  // 起始视口下侧轨宽度固定，按实测工具栏宽度定位容器断点两侧。
  await page.setViewportSize({ width: 800, height: 844 });
  const container = toolbar.locator('.surface-toolbar-primary > div');
  const baseline = await container.evaluate((element) => element.clientWidth);
  const boundary = 800 + 768 - baseline;
  await page.setViewportSize({ width: boundary - 2, height: 844 });
  await expect(more).toBeVisible();
  await expectToolbarHits(toolbar);
  await page.setViewportSize({ width: boundary + 2, height: 844 });
  await expect(toolbar.getByRole('button', { name: '详情面板', exact: true })).toBeVisible();
  await expectToolbarHits(toolbar);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(toolbar.getByRole('navigation', { name: '完整目录路径' })).toBeVisible();
  await more.click();
  await expect(page.getByRole('menuitemradio', { name: '名称', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  await expectToolbarHits(toolbar);
  await page.screenshot({ path: info.outputPath('V-01-1280.png') });

  await page.setViewportSize({ width: 320, height: 844 });
  for (const [url, title] of [
    ['/home', '我的文件'],
    ['/home?category=image', '图片'],
    ['/home?trash=true', '回收站'],
  ]) {
    await page.goto(url);
    const current = page.getByRole('toolbar', { name: title, exact: true });
    await expect(current.getByTitle(title, { exact: true })).toBeVisible();
    await expectToolbarHits(current);
  }
});

test('V-02 详情抽屉与侧栏保持选择、内容和关闭焦点', async ({ page }, info) => {
  await login(page);
  const folder = await createEntry(page, 'folders', '详情-' + randomUUID().slice(0, 8));
  const first = await createEntry(page, 'text', '第一份详情.txt', folder.id);
  const second = await createEntry(page, 'text', '第二份详情.txt', folder.id);
  const selected = (id: string) =>
    page.locator('[data-file-item="' + id + '"]').getByRole('checkbox');
  await page.goto('/home?parent=' + folder.id);
  await expect(selected(first.id)).toBeVisible();
  const toolbar = page.getByRole('toolbar', { name: folder.name, exact: true });
  const more = toolbar.getByRole('button', { name: /^更多(?:目录)?操作$/ });
  const details = toolbar.getByRole('button', { name: '详情面板', exact: true });
  const drawer = page.getByRole('dialog', { name: '详情面板', exact: true });
  const dock = page.getByRole('complementary', { name: '详情面板', exact: true });
  const openDetails = async () => {
    if (!(await details.isVisible())) {
      await more.click();
      await page.getByRole('menuitem', { name: '详情面板', exact: true }).click();
    } else await details.click();
  };

  for (const width of [390, 713, 800, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const surface = width < 1024 ? drawer : dock;
    const trigger = width < 1024 ? more : details;
    await openDetails();
    await expect(surface.getByText('选中一个文件或文件夹以查看详情与快捷操作。')).toBeVisible();
    await surface.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(surface).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await selected(first.id).check();
    await openDetails();
    await expect(surface.getByText(first.name, { exact: true })).toBeVisible();
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath('V-02-' + width + '.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(surface).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(selected(first.id)).toBeChecked();

    await selected(second.id).check();
    await openDetails();
    await expect(surface.getByText('已选择 2 项，总大小 10 B')).toBeVisible();
    await surface.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(surface).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(selected(second.id)).toBeChecked();
    await selected(first.id).uncheck();
    await selected(second.id).uncheck();
    // 切换页面清除集合的键盘聚焦项，下一断点重新测试空态。
    await page.reload();
    await expect(selected(first.id)).toBeVisible();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await selected(first.id).check();
  await openDetails();
  await expect(drawer.getByText(first.name, { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(drawer).toHaveCount(0);
  await expect(dock.getByText(first.name, { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dock).toHaveCount(0);
  await expect(drawer.getByText(first.name, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(selected(first.id)).toBeChecked();
});

test('V-03 真实目录分页与五个目标选择入口读回同一作用范围', async ({ page }, info) => {
  test.setTimeout(180_000);
  await login(page);
  const root = await createEntry(page, 'folders', '000-目录分页-' + randomUUID().slice(0, 8));
  const children: { id: string; name: string }[] = [];
  for (let index = 1; index <= 43; index++)
    children.push(
      await createEntry(page, 'folders', 'z-' + String(index).padStart(2, '0'), root.id),
    );
  for (let index = 1; index <= 22; index++)
    await createEntry(page, 'text', 'a-' + String(index).padStart(2, '0') + '.txt', root.id);
  const [empty, onlyFiles, exactlyOnePage] = children;
  const [mount, extractTarget, createTarget] = children.slice(40);
  await createEntry(page, 'text', 'not-a-directory.txt', onlyFiles.id);
  await createEntry(page, 'text', 'scope-proof.txt', mount.id);
  for (let index = 1; index <= 20; index++)
    await createEntry(
      page,
      'folders',
      'single-' + String(index).padStart(2, '0'),
      exactlyOnePage.id,
    );

  const button = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
  const choose = (picker: Locator, name: string) => button(picker, '进入 ' + name).click();
  const jump = async (picker: Locator, index: number) => {
    await picker.getByRole('textbox', { name: '跳至页码' }).fill(String(index));
    await button(picker, '跳转').click();
    await expect(picker.getByText(`第 ${index} / 3 页，共 43 项`, { exact: true })).toBeVisible();
  };
  const openRoot = () => page.goto('/home?parent=' + root.id);
  const destination = (dialog: Locator) => dialog.getByRole('region', { name: '保存位置' });
  const openDestination = async (picker: Locator, target: { name: string }) => {
    await jump(picker, 3);
    await choose(picker, target.name);
    await expect(picker.getByText('我的文件 / ' + root.name + ' / ' + target.name)).toBeVisible();
  };

  await page.goto('/home/connections');
  await button(page.getByRole('main'), '创建连接').click();
  const connection = page.getByRole('dialog', { name: '创建连接', exact: true });
  const access = connection.getByRole('region', { name: '可访问目录' });
  const connectionName = '分页授权-' + root.name;
  await connection.getByLabel('备注名称').fill(connectionName);
  await connection.getByRole('checkbox', { name: '只读', exact: true }).check();
  await button(access, root.name + '/').click();
  const checkPage = async (index: number) => {
    await expect(access.getByText(`第 ${index} / 3 页，共 43 项`, { exact: true })).toBeVisible();
    await expect(access.getByRole('list').getByRole('button')).toHaveText(
      children.slice((index - 1) * 20, index * 20).map(({ name }) => name + '/'),
    );
  };
  await checkPage(1);
  await expect(button(access, '上一页')).toBeDisabled();
  await button(access, '下一页').click();
  await checkPage(2);
  await button(access, '上一页').click();
  await checkPage(1);
  for (const folder of [empty, onlyFiles, exactlyOnePage]) {
    await button(access, folder.name + '/').click();
    await expect(access.getByText('当前选择: /' + root.name + '/' + folder.name)).toBeVisible();
    await expect(button(access, '下一页')).toHaveCount(0);
    if (folder !== exactlyOnePage)
      await expect(access.getByText('本页没有可选子文件夹')).toBeVisible();
    else await expect(access.getByRole('list').getByRole('button')).toHaveCount(20);
    await button(access, root.name).click();
    await checkPage(1);
  }
  await jump(access, 3);
  await checkPage(3);
  await expect(button(access, '下一页')).toBeDisabled();
  await page.screenshot({ path: info.outputPath('V-03-page-3.png'), animations: 'disabled' });
  await access.getByRole('textbox', { name: '跳至页码' }).fill('4');
  await button(access, '跳转').click();
  await expect(access.getByText('请输入 1 至 3 的整数')).toBeVisible();

  const isFolderRequest = (parent: string) => (url: URL) =>
    url.pathname === files &&
    url.searchParams.get('parent') === parent &&
    url.searchParams.get('kinds') === 'folder';
  const started = requestGate();
  const resume = requestGate();
  await page.route(
    isFolderRequest(extractTarget.id),
    async (route) => {
      started.release();
      await resume.promise;
      await route.continue().catch(() => undefined);
    },
    { times: 1 },
  );
  try {
    await button(access, extractTarget.name + '/').click();
    await started.promise;
    await expect(button(connection, '创建')).toBeDisabled();
    await button(access, '/').click();
    await expect(button(access, root.name + '/')).toBeVisible();
  } finally {
    resume.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await expect(access.getByText('当前选择: /', { exact: true })).toBeVisible();
  await button(access, root.name + '/').click();
  await checkPage(1);
  await jump(access, 3);
  await page.route(isFolderRequest(mount.id), (route) => route.fulfill({ status: 503 }), {
    times: 1,
  });
  await button(access, mount.name + '/').click();
  await expect(access.getByRole('alert')).toBeVisible();
  await expect(button(connection, '创建')).toBeDisabled();
  await expect(connection.getByLabel('备注名称')).toHaveValue(connectionName);
  await button(access, '重新读取').click();
  const mountPath = '/' + root.name + '/' + mount.name;
  await expect(access.getByText('当前选择: ' + mountPath)).toBeVisible();
  await page.screenshot({ path: info.outputPath('V-03-WebDAV.png'), animations: 'disabled' });
  await button(connection, '创建').click();
  const issued = page.getByRole('dialog', { name: '保存连接凭据', exact: true });
  await expect(issued).toBeVisible();
  const [endpoint, username, password] = await issued.locator('code').allTextContents();
  const dav = await page.request.fetch(endpoint, {
    method: 'PROPFIND',
    headers: {
      Depth: '1',
      Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
    },
  });
  expect(dav.status()).toBe(207);
  expect(await dav.text()).toContain('scope-proof.txt');
  await button(issued, '关闭').click();
  await expect(
    page.getByRole('main').getByText('可访问目录: ' + mountPath, { exact: true }),
  ).toBeVisible();

  await openRoot();
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('menuitem', { name: '创建文件夹', exact: true }).click();
  const create = page.getByRole('dialog', { name: '创建文件夹', exact: true });
  await create.getByLabel('名称').fill('真实创建结果');
  await openDestination(destination(create), createTarget);
  await button(create, '确认').click();
  await expect(create).toHaveCount(0);
  await page.goto('/home?parent=' + createTarget.id);
  await expect(page.getByRole('button', { name: '真实创建结果', exact: true })).toBeVisible();

  await openRoot();
  await page.getByRole('button', { name: 'a-01.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '创建 ZIP 压缩包', exact: true }).click();
  const zip = page.getByRole('dialog', { name: '创建 ZIP 压缩包', exact: true });
  const zipName = root.name + '.zip';
  await zip.getByLabel('ZIP 文件名').fill(zipName);
  await openDestination(destination(zip), mount);
  await button(zip, '开始压缩').click();
  await expect(zip).toHaveCount(0);
  await page.goto('/home/tasks');
  const task = page.getByRole('listitem').filter({
    has: page.getByRole('heading', { name: zipName, exact: true }),
  });
  await expect(task.getByText('已完成', { exact: true })).toBeVisible();
  await button(task, '定位 ZIP 文件').click();
  await expect(page).toHaveURL(new RegExp('parent=' + mount.id));
  await page.getByRole('button', { name: zipName, exact: true }).click();
  const archive = page.getByRole('dialog', { name: zipName, exact: true });
  await button(archive, '全部解压').click();
  const extract = page.getByRole('dialog', { name: '解压到目录', exact: true });
  const extraction = destination(extract);
  await button(extraction, '上一级').click();
  await openDestination(extraction, extractTarget);
  await button(extract, '开始解压').click();
  await expect(archive.getByRole('region', { name: '解压结果', exact: true })).toBeVisible();
  await page.goto('/home?parent=' + extractTarget.id);
  await expect(page.getByRole('button', { name: 'a-01.txt', exact: true })).toBeVisible();

  await openRoot();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = '#603890';
    context.fillRect(0, 0, 32, 24);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('menuitem', { name: '上传文件', exact: true }).click();
  await button(page.getByRole('dialog', { name: '上传文件', exact: true }), '使用此位置').click();
  await (
    await chooser
  ).setFiles({
    name: '0-source.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  });
  const queue = page.getByRole('dialog', { name: '上传队列', exact: true });
  await expect(queue.getByText('上传完成', { exact: true })).toBeVisible();
  await button(queue, '关闭').click();
  await page.getByRole('button', { name: '0-source.png', exact: true }).click();
  await page.getByRole('button', { name: '编辑副本', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '图片编辑器', exact: true });
  await button(editor, '更改副本保存位置').click();
  const imagePicker = page.getByRole('dialog', { name: '选择副本保存位置', exact: true });
  await openDestination(destination(imagePicker), createTarget);
  await button(imagePicker, '使用此位置').click();
  await editor.getByLabel('副本名称（不含扩展名）').fill('p1-copy');
  await button(editor, '上传副本到所选位置').click();
  await expect
    .poll(() =>
      page.evaluate(
        async (url) => {
          const response = await fetch(url, { cache: 'no-store' });
          if (!response.ok) throw new Error('读取已保存的目标目录失败，状态码 ' + response.status);
          return ((await response.json()) as { items: { name: string }[] }).items.map(
            ({ name }) => name,
          );
        },
        files + '?parent=' + createTarget.id,
      ),
    )
    .toContain('p1-copy.png');
});
