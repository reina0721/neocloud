import {
  readProductStorage,
  removeProductStorage,
  writeProductStorage,
} from '@neocloud/state-foundation';
import {
  defaultFileSidebarPreferences,
  fileSidebarPreferencesSchema,
  FilesError,
  type FileSidebarPreferences,
} from '@neocloud/surface/files';

const sidebarKey = 'neocloud.files.sidebar.v2';
const previousSidebarKey = 'neocloud.files.sidebar.v1';

/** createFileSidebarPreferences 拥有设备侧栏偏好，旧键只在新文档成功落盘后移除。 */
export function createFileSidebarPreferences(account: string | null, assertCurrent: () => void) {
  const key = sidebarKey + '.' + account;
  return {
    loadSidebarPreferences(): FileSidebarPreferences {
      assertCurrent();
      try {
        const saved = readProductStorage(localStorage, key);
        if (saved !== null) return fileSidebarPreferencesSchema.parse(JSON.parse(saved));
        const previous = readProductStorage(localStorage, previousSidebarKey + '.' + account);
        const collapsed: unknown =
          previous === null ? defaultFileSidebarPreferences.collapsed : JSON.parse(previous);
        if (typeof collapsed !== 'boolean') throw new FilesError('invalid');
        const preferences = { ...defaultFileSidebarPreferences, collapsed };
        writeProductStorage(localStorage, key, JSON.stringify(preferences));
        if (previous !== null)
          removeProductStorage(localStorage, previousSidebarKey + '.' + account);
        return preferences;
      } catch (error) {
        throw new FilesError('invalid', { cause: error });
      }
    },
    saveSidebarPreferences(input: FileSidebarPreferences) {
      assertCurrent();
      try {
        writeProductStorage(
          localStorage,
          key,
          JSON.stringify(fileSidebarPreferencesSchema.parse(input)),
        );
      } catch (error) {
        throw new FilesError('unavailable', { cause: error });
      }
    },
  };
}
