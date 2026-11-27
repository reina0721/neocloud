import { readNeoCloudEnv } from '../apps/web/runtime/environment.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const origin = new URL(readNeoCloudEnv('NATIVE_BROWSER_ORIGIN') ?? '');
assert.equal(origin.protocol, 'http:');
assert.equal(origin.hostname, '127.0.0.1');
assert.notEqual(origin.port, '4180', 'Use an isolated acceptance instance');
const email = readNeoCloudEnv('NATIVE_BROWSER_EMAIL');
const password = readNeoCloudEnv('NATIVE_BROWSER_PASSWORD');
assert.ok(email && password, 'Missing isolated test credentials');
const output = readNeoCloudEnv('NATIVE_BROWSER_OUTPUT');
if (output) await mkdir(output, { recursive: true });

const pagePath = '/system-tools/update';
const update = '/api/console/v1/deployment/native-update';
const consoleAPI = '/api/console/v1';
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    baseURL: origin.origin,
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  assert.equal((await page.request.get(update)).status(), 401);
  await page.goto(pagePath);
  await expect(page).toHaveURL(/\/login\?/);
  await page.getByLabel(/^(邮箱|Email)$/i).fill(email);
  await page.getByLabel(/^(密码|Password)$/i).fill(password);
  await page.getByRole('button', { name: /^(登录|Sign in)$/i }).click();
  await expect(page).toHaveURL(new URL(pagePath, origin).href);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: /^(系统更新|System Update)$/i })).toBeVisible();
  await expect(main.getByText(/Go v0\.9\.10 · Web v0\.9\.10/)).toBeVisible();
  await expect(main.getByRole('button', { name: /^(回退|Roll back)$/i })).toBeDisabled();
  if (output) await page.screenshot({ path: join(output, 'before-update.png'), fullPage: true });

  const api = page.request;
  const token = async () => {
    const response = await api.get(consoleAPI + '/auth/csrf');
    assert.equal(response.status(), 200);
    return (await response.json()).token;
  };
  const headers = { Origin: origin.origin, 'X-CSRF-Token': await token() };
  const denied = await api.post(update + '/jobs', {
    headers: { ...headers, Origin: 'https://foreign.example' },
    data: { action: 'apply' },
  });
  assert.equal(denied.status(), 403);
  const session = async () =>
    (await (await api.get(consoleAPI + '/auth/session')).json()).sessionId;
  const originalSession = await session();
  assert.equal(typeof originalSession, 'string');

  async function createText(name, text) {
    const response = await api.post(consoleAPI + '/native/files/text', {
      headers: { Origin: origin.origin, 'X-CSRF-Token': await token() },
      data: { name, text, parentId: '', key: name },
    });
    assert.ok(response.ok(), 'Creating text fixture');
    return (await response.json()).id;
  }
  async function verifyText(id, text) {
    const response = await api.get(consoleAPI + '/native/files/' + id + '/content');
    assert.equal(response.status(), 200);
    assert.equal(await response.text(), text);
  }
  async function execute(label, version) {
    await main.getByRole('button', { name: label }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: label }).click();
    await expect(main.getByText(`Go ${version} · Web ${version}`, { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    assert.equal(await session(), originalSession);
  }
  const first = await createText('before-native-update.txt', 'acknowledged by A');
  const upload = Buffer.from('the acknowledged offset survives a complete release switch');
  const startTransfer = await api.post(consoleAPI + '/native/files/transfers', {
    headers: { Origin: origin.origin, 'X-CSRF-Token': await token() },
    data: {
      name: 'native-resumed.bin',
      parentId: '',
      key: 'native-browser-resume',
      sizeBytes: upload.length,
      sha256: createHash('sha256').update(upload).digest('hex'),
    },
  });
  assert.ok(startTransfer.ok(), 'Starting resumable upload');
  const transfer = consoleAPI + '/native/files/transfers/' + (await startTransfer.json()).id;
  const tusHeaders = { Origin: origin.origin, 'Tus-Resumable': '1.0.0' };
  const split = 17;
  async function patch(offset, data, wantOffset) {
    const response = await api.patch(transfer + '/data', {
      headers: {
        ...tusHeaders,
        'X-CSRF-Token': await token(),
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset),
      },
      data,
    });
    assert.equal(response.status(), 204);
    assert.equal(response.headers()['upload-offset'], String(wantOffset));
  }
  await patch(0, upload.subarray(0, split), split);
  await execute(/^(升级|Upgrade)$/i, 'v0.9.11');
  await expect(main.getByText('v0.9.10', { exact: true })).toHaveCount(0);
  const offset = await api.head(transfer + '/data', { headers: tusHeaders });
  assert.equal(offset.headers()['upload-offset'], String(split));
  await patch(split, upload.subarray(split), upload.length);
  const committed = await api.post(transfer + '/commit', {
    headers: { Origin: origin.origin, 'X-CSRF-Token': await token() },
  });
  assert.ok(committed.ok(), 'Committing resumed upload');
  const resumed = (await committed.json()).entryId;
  await verifyText(first, 'acknowledged by A');
  const second = await createText('after-native-update.txt', 'acknowledged by B');
  if (output) await page.screenshot({ path: join(output, 'after-update.png'), fullPage: true });
  await execute(/^(回退|Roll back)$/i, 'v0.9.10');
  await verifyText(first, 'acknowledged by A');
  await verifyText(second, 'acknowledged by B');
  const resumedFile = await api.get(consoleAPI + '/native/files/' + resumed + '/content');
  assert.equal(resumedFile.status(), 200);
  assert.deepEqual(await resumedFile.body(), upload);
  await page.reload();
  await expect(main.getByText(/Go v0\.9\.10 · Web v0\.9\.10/)).toBeVisible();

  const notFound = await api.get('/api/not-a-route');
  assert.equal(notFound.status(), 404);
  assert.match(notFound.headers()['content-type'] ?? '', /json/i);
  const missingAsset = await api.get('/_next/static/missing-resource.js');
  assert.equal(missingAsset.status(), 404);
  const flight = await api.get('/home.txt', { headers: { RSC: '1' } });
  assert.match(flight.headers()['content-type'] ?? '', /^text\/plain/);
  const navigationOrigin = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('link', { name: /^(返回我的文件|Back to files)$/i }).click();
  await expect(page).toHaveURL(new URL('/home', origin).href);
  assert.equal(await page.evaluate(() => performance.timeOrigin), navigationOrigin);
  await expect(page.getByText('after-native-update.txt', { exact: true })).toBeVisible();
  if (output) await page.screenshot({ path: join(output, 'after-rollback.png'), fullPage: true });

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('menuitem', { name: '上传文件', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '使用此位置', exact: true }).click();
  const pdf = 'native-preview.pdf';
  await (
    await chooser
  ).setFiles({
    name: pdf,
    mimeType: 'application/pdf',
    buffer: await readFile(new URL('../file-tests/fixtures/pdf/reader.pdf', import.meta.url)),
  });
  const queue = page.getByRole('dialog', { name: '上传队列', exact: true });
  await expect(queue.getByText('上传完成', { exact: true })).toBeVisible({ timeout: 20_000 });
  await queue.getByRole('button', { name: '关闭', exact: true }).click();
  const pdfFrame = page.waitForResponse(
    (response) =>
      response.request().resourceType() === 'document' &&
      new URL(response.url()).pathname.startsWith('/file-viewers/pdf/'),
  );
  await page.getByRole('button', { name: pdf, exact: true }).click();
  const response = await pdfFrame;
  assert.match(response.headers()['content-security-policy'] ?? '', /frame-ancestors 'self'/);
  const preview = page.getByRole('dialog', { name: pdf, exact: true });
  await expect(preview.frameLocator('iframe').locator('canvas').first()).toBeVisible({
    timeout: 20_000,
  });
  if (output) await page.screenshot({ path: join(output, 'static-pdf.png'), fullPage: true });
  const share = await api.post(consoleAPI + '/native/files/shares', {
    headers: { Origin: origin.origin, 'X-CSRF-Token': await token() },
    data: { rootId: second, title: 'Native public share' },
  });
  assert.ok(share.ok(), 'Creating public share fixture');
  const { token: shareToken } = await share.json();
  const publicContext = await browser.newContext({ baseURL: origin.origin, locale: 'zh-CN' });
  const visitor = await publicContext.newPage();
  const shareData = visitor.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith('/api/v1/file-shares/'),
  );
  await visitor.goto('/share#token=' + encodeURIComponent(shareToken));
  assert.ok((await shareData).ok(), 'Anonymous share metadata');
  await expect(visitor.getByText('after-native-update.txt', { exact: true }).first()).toBeVisible();
  console.log(
    'Chromium passed native login, paired upgrade, rollback, TUS, share, navigation and PDF',
  );
} finally {
  await browser.close();
}
