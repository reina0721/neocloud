const product = /^neocloud(?=[.-]|$)/;

export function legacyStorageKey(key: string): string {
  return key.replace(product, 'clouddrive');
}

export function isProductStorageKey(key: string): boolean {
  return key.startsWith('neocloud.') || key.startsWith('clouddrive.');
}

function mirror(storage: Storage, key: string, value: string | null) {
  try {
    if (value === null) storage.removeItem(key);
    else if (storage.getItem(key) !== value) storage.setItem(key, value);
  } catch {
    // 兼容窗口读取旧键。镜像配额不足时保留实际写入，随后读取或重试继续同步。
  }
}

export function readProductStorage(storage: Storage, key: string): string | null {
  const legacy = legacyStorageKey(key);
  const value = storage.getItem(legacy);
  if (legacy !== key) mirror(storage, key, value);
  return value;
}

export function writeProductStorage(storage: Storage, key: string, value: string): void {
  const legacy = legacyStorageKey(key);
  storage.setItem(legacy, value);
  if (legacy !== key) mirror(storage, key, value);
}

export function removeProductStorage(storage: Storage, key: string): void {
  const legacy = legacyStorageKey(key);
  storage.removeItem(legacy);
  if (legacy !== key) mirror(storage, key, null);
}
