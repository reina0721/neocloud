// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { createLocalStorage } from './local';
import { createSessionStorage } from './session';

type Payload = { theme: 'light' | 'dark' };

describe('web storage adapters (jsdom)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('localStorage roundtrip（StorageValue JSON 形状）', () => {
    const storage = createLocalStorage<Payload>();
    // persist middleware 写入的是 { state, version }（StorageValue）；这里模拟之。
    storage.setItem('clouddrive.shell', { state: { theme: 'dark' }, version: 1 });
    expect(storage.getItem('clouddrive.shell')).toEqual({
      state: { theme: 'dark' },
      version: 1,
    });
    expect(window.localStorage.getItem('clouddrive.shell')).toContain('"theme":"dark"');
  });

  it('sessionStorage roundtrip + remove', () => {
    const storage = createSessionStorage<Payload>();
    storage.setItem('clouddrive.session', { state: { theme: 'light' }, version: 1 });
    expect(storage.getItem('clouddrive.session')).toEqual({
      state: { theme: 'light' },
      version: 1,
    });
    storage.removeItem('clouddrive.session');
    expect(storage.getItem('clouddrive.session')).toBeNull();
  });

  it('旧标签页写入与删除在升级和回退期间保持权威', () => {
    const storage = createLocalStorage<Payload>();
    const native = window.localStorage;
    const legacy = 'clouddrive.shell';
    const current = 'neocloud.shell';
    const dark = { state: { theme: 'dark' }, version: 1 } as const;
    const light = { state: { theme: 'light' }, version: 1 } as const;

    native.setItem(legacy, JSON.stringify(dark));
    expect(storage.getItem(current)).toEqual(dark);
    expect(native.getItem(current)).toBe(JSON.stringify(dark));
    storage.setItem(current, light);
    expect(native.getItem(legacy)).toBe(JSON.stringify(light));
    native.setItem(legacy, JSON.stringify(dark));
    expect(storage.getItem(current)).toEqual(dark);
    native.removeItem(legacy);
    expect(storage.getItem(current)).toBeNull();
    expect(native.getItem(current)).toBeNull();
  });

  it('unavailablePolicy=noop 工厂可创建（lazy，无 window 也不崩）', () => {
    const storage = createLocalStorage<Payload>({ unavailablePolicy: 'noop' });
    expect(typeof storage.getItem).toBe('function');
  });
});
