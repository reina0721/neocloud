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
    storage.setItem('neocloud.shell', { state: { theme: 'dark' }, version: 1 });
    expect(storage.getItem('neocloud.shell')).toEqual({
      state: { theme: 'dark' },
      version: 1,
    });
    expect(window.localStorage.getItem('neocloud.shell')).toContain('"theme":"dark"');
  });

  it('sessionStorage roundtrip + remove', () => {
    const storage = createSessionStorage<Payload>();
    storage.setItem('neocloud.session', { state: { theme: 'light' }, version: 1 });
    expect(storage.getItem('neocloud.session')).toEqual({
      state: { theme: 'light' },
      version: 1,
    });
    storage.removeItem('neocloud.session');
    expect(storage.getItem('neocloud.session')).toBeNull();
  });

  it('unavailablePolicy=noop 工厂可创建（lazy，无 window 也不崩）', () => {
    const storage = createLocalStorage<Payload>({ unavailablePolicy: 'noop' });
    expect(typeof storage.getItem).toBe('function');
  });
});
