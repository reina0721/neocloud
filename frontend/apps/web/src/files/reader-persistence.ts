import type {
  ReaderBookmark,
  ReaderDraft,
  ReaderPersistence,
} from '@neocloud/surface/files/runtime';
import { registerDirtySource } from '../host/leave-confirm';
import { downloadBlob } from './native-download';

const databaseName = 'neocloud-file-readers';
const tabKey = 'neocloud-file-reader-tab';

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase() {
  const request = indexedDB.open(databaseName, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('workspace');
    db.createObjectStore('draft', { keyPath: 'key' });
  };
  return requestResult(request);
}

async function transaction<T>(
  store: 'workspace' | 'draft',
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>,
) {
  const db = await openDatabase();
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
    const current = sessionStorage.getItem(tabKey);
    if (current) return current;
    sessionStorage.setItem(tabKey, fresh);
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
      const value: unknown = await transaction('workspace', 'readonly', (store) =>
        requestResult(store.get(workspaceKey())),
      );
      return Array.isArray(value) ? value.filter(isBookmark).slice(0, 9) : [];
    },
    write(bookmarks) {
      const write = workspaceWrite.then(async () => {
        await transaction('workspace', 'readwrite', (store) =>
          requestResult(store.put(bookmarks, workspaceKey())),
        );
      });
      workspaceWrite = write.catch(() => {});
      return write;
    },
    async hasDraft(fileId, application) {
      const count = await transaction('draft', 'readonly', (store) =>
        requestResult(store.count(draftKey(fileId, application))),
      );
      return count > 0;
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
          return transaction('draft', 'readonly', (store) =>
            requestResult(store.get(key()) as IDBRequest<ReaderDraft | undefined>),
          );
        },
        async write(draft) {
          await transaction('draft', 'readwrite', (store) =>
            requestResult(store.put({ ...draft, key: key() })),
          );
        },
        async clear() {
          await transaction('draft', 'readwrite', (store) => requestResult(store.delete(key())));
        },
      };
    },
  };
}
