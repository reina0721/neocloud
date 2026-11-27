import type {
  ReaderBookmark,
  ReaderDraft,
  ReaderPersistence,
} from '@neocloud/surface/files/runtime';
import {
  legacyStorageKey,
  readProductStorage,
  writeProductStorage,
} from '@neocloud/state-foundation';
import { registerDirtySource } from '../host/leave-confirm';
import { downloadBlob } from './native-download';

const databaseName = 'neocloud-file-readers';
const legacyDatabaseName = legacyStorageKey(databaseName);
const tabKey = 'neocloud-file-reader-tab';
type ReaderStore = 'workspace' | 'draft';

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(name: string) {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('workspace');
    db.createObjectStore('draft', { keyPath: 'key' });
  };
  return requestResult(request);
}

async function transaction<T>(
  name: string,
  store: ReaderStore,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>,
) {
  const db = await openDatabase(name);
  try {
    const tx = db.transaction(store, mode);
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
    const [result] = await Promise.all([operation(tx.objectStore(store)), completed]);
    return result;
  } finally {
    db.close();
  }
}

function storeEntry(name: string, store: ReaderStore, key: string, value: unknown) {
  return transaction(name, store, 'readwrite', async (records) => {
    if (value === undefined) await requestResult(records.delete(key));
    else
      await requestResult(records.keyPath === null ? records.put(value, key) : records.put(value));
  });
}

async function mirrorEntry(store: ReaderStore, key: string, value: unknown) {
  try {
    await storeEntry(databaseName, store, key, value);
  } catch {
    // 旧库承接回退期间的读写。稍后从其最新记录重建镜像，保留实际已保存的草稿。
  }
}

async function readEntry<T>(store: ReaderStore, key: string) {
  const value = await transaction(legacyDatabaseName, store, 'readonly', (records) =>
    requestResult(records.get(key) as IDBRequest<T | undefined>),
  );
  await mirrorEntry(store, key, value);
  return value;
}

async function writeEntry(store: ReaderStore, key: string, value: unknown) {
  await storeEntry(legacyDatabaseName, store, key, value);
  await mirrorEntry(store, key, value);
}

function isBookmark(value: unknown): value is ReaderBookmark {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<ReaderBookmark>;
  return (
    typeof item.fileId === 'string' &&
    typeof item.application === 'string' &&
    (item.position === undefined || (Number.isFinite(item.position) && item.position >= 0)) &&
    (item.shelf === undefined || (item.shelf === 'video' && item.application === 'video'))
  );
}

function readerTab() {
  const fresh = crypto.randomUUID();
  try {
    const current = readProductStorage(sessionStorage, tabKey);
    if (current) return current;
    writeProductStorage(sessionStorage, tabKey, fresh);
  } catch {
    // 存储受限时仍可使用当前工作区。
  }
  return fresh;
}

export function createReaderPersistence(account: string): ReaderPersistence {
  // 延迟读取标签页身份，服务端渲染不会访问浏览器存储。
  let writer: string | undefined;
  const workspaceKey = () => JSON.stringify([account, (writer ??= readerTab())]);
  const draftKey = (fileId: string, application: string) =>
    JSON.stringify([workspaceKey(), fileId, application]);
  let workspaceWrite = Promise.resolve();
  return {
    async read() {
      const value = await readEntry<unknown>('workspace', workspaceKey());
      return Array.isArray(value) ? value.filter(isBookmark).slice(0, 9) : [];
    },
    write(bookmarks) {
      const write = workspaceWrite.then(() => writeEntry('workspace', workspaceKey(), bookmarks));
      workspaceWrite = write.catch(() => {});
      return write;
    },
    async hasDraft(fileId, application) {
      return (await readEntry<ReaderDraft>('draft', draftKey(fileId, application))) !== undefined;
    },
    draft(fileId, application) {
      const key = () => draftKey(fileId, application);
      return {
        download: (name, data, type) => downloadBlob(new Blob([data], { type }), name),
        guard: (message) =>
          registerDirtySource({
            pageId: 'reader-draft:' + key(),
            isDirty: () => true,
            message: () => message,
          }),
        async read() {
          return readEntry<ReaderDraft>('draft', key());
        },
        async write(draft) {
          await writeEntry('draft', key(), { ...draft, key: key() });
        },
        async clear() {
          await writeEntry('draft', key(), undefined);
        },
      };
    },
  };
}
