import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Page } from '@playwright/test';

/** 配置与用例共用同一个本地预览凭据入口，不把某次验收端口写成产品契约。 */
const frontend = resolve(__dirname, '..');
const localData = resolve(frontend, '../.data');

function isWithinData(path: string): boolean {
  const from = relative(realpathSync(localData), realpathSync(path));
  return from !== '' && from !== '..' && !from.startsWith('..' + sep) && !isAbsolute(from);
}

function localOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.hostname !== '127.0.0.1' ||
    url.protocol !== 'http:' ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Files browser tests require a named-port loopback preview origin.');
  return url;
}

export function readPreviewAccess() {
  const current = resolve(localData, 'preview/access.json');
  const path = process.env.CLOUDDRIVE_FILE_TEST_ACCESS
    ? resolve(frontend, process.env.CLOUDDRIVE_FILE_TEST_ACCESS)
    : existsSync(current)
      ? current
      : resolve(localData, 'preview-access.json');
  if (!isWithinData(path)) throw new Error('Files preview credentials must be inside local .data.');
  const access: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  if (
    typeof access !== 'object' ||
    !access ||
    !('url' in access) ||
    typeof access.url !== 'string' ||
    !('username' in access) ||
    typeof access.username !== 'string' ||
    !access.username ||
    !('password' in access) ||
    typeof access.password !== 'string' ||
    !access.password ||
    !('apiUrl' in access) ||
    typeof access.apiUrl !== 'string' ||
    !('dataDirectory' in access) ||
    typeof access.dataDirectory !== 'string' ||
    !isAbsolute(access.dataDirectory)
  )
    throw new Error('Run node scripts/dev.mjs --preview to prepare isolated preview access.');
  const marker = 'environment' in access ? access.environment : undefined;
  const legacy =
    marker === undefined &&
    path === resolve(localData, 'preview-access.json') &&
    resolve(access.dataDirectory) === resolve(localData, 'file-preview');
  if (
    (!legacy && marker !== 'clouddrive-node-preview-v1') ||
    !isWithinData(access.dataDirectory) ||
    !existsSync(resolve(access.dataDirectory, 'initialized'))
  )
    throw new Error('Files browser tests require a provisioned isolated preview manifest.');
  const url = localOrigin(access.url);
  const api = localOrigin(access.apiUrl);
  if (url.origin === api.origin || api.pathname !== '/')
    throw new Error('The isolated preview must declare distinct Web and API origins.');
  return {
    path,
    url: access.url,
    origin: url.origin,
    apiOrigin: api.origin,
    dataDirectory: realpathSync(access.dataDirectory),
    publicationOrigin:
      'publicationOrigin' in access && typeof access.publicationOrigin === 'string'
        ? access.publicationOrigin
        : process.env.CLOUDDRIVE_TEST_PUBLICATION_ORIGIN,
    offlineSourceAllowed:
      'offlineSourceAllowed' in access
        ? access.offlineSourceAllowed === true
        : process.env.CLOUDDRIVE_FILE_TEST_OFFLINE_SOURCE_ALLOWED === '1',
    username: access.username,
    password: access.password,
  };
}

/** 附加账号可由专用场景发放，但浏览器目标须和本轮隔离实例一致。 */
export function assertPreviewOrigin(value: string): string {
  const origin = localOrigin(value).origin;
  if (origin !== readPreviewAccess().origin)
    throw new Error('Files fixture origin differs from the configured isolated preview.');
  return origin;
}

export function allowsOfflineFixture(): boolean {
  return readPreviewAccess().offlineSourceAllowed;
}

export async function editReadingFixtureText(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await dialog.getByRole('button', { name: '编辑', exact: true }).click();
  await page.waitForURL(/\/home\/view\?/);
  return dialog;
}

export async function fileCollectionAction(
  page: Page,
  name: string,
  role: 'menuitem' | 'menuitemradio' = 'menuitem',
) {
  const label = /^更多(?:目录)?操作$/;
  await page.locator('[data-file-collection-actions]').getByRole('button', { name: label }).click();
  await page.getByRole('menu', { name: label }).getByRole(role, { name, exact: true }).click();
}

export async function openReadingFixtureFolder(page: Page, prefix: string) {
  const name = prefix + randomUUID().slice(0, 8);
  const id = await page.evaluate(async (name) => {
    const csrf = await fetch('/api/console/v1/auth/csrf');
    if (!csrf.ok) throw new Error('Reading fixture CSRF HTTP ' + csrf.status);
    const { token } = (await csrf.json()) as { token: string };
    const response = await fetch('/api/console/v1/native/files/folders', {
      method: 'POST',
      headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: '', name }),
    });
    if (!response.ok) throw new Error('Reading fixture folder HTTP ' + response.status);
    return ((await response.json()) as { id: string }).id;
  }, name);
  await page.goto('/home?parent=' + encodeURIComponent(id));
  return { id, name };
}
