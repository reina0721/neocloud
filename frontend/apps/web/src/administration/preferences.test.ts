// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountPreferences, AdministrationPort } from '@clouddrive/surface/administration';
import { defaultPreferences, type Preferences } from '@clouddrive/surface/preferences-model';
import { ApiError } from '../api/json-client';
import { createHostPreferencesPort } from '../host/preferences-port';
import { useShellStore } from '../state/use-shell-store';
import { createAccountPreferencesSync } from './preferences';

const base: AccountPreferences = {
  version: 2,
  language: 'zh-CN',
  timeZone: '',
  themeMode: 'light',
  themePreset: 'cyan',
  density: 'compact',
  reduceMotion: true,
  notifications: { emailDigest: false, inApp: true, showSummaries: true, dailySummary: false },
};

function deferredPreferences() {
  let resolve!: (value: AccountPreferences) => void;
  const promise = new Promise<AccountPreferences>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function start(writable = true) {
  let owner = true;
  const host = createHostPreferencesPort();
  const publish = vi.fn();
  const port = {
    preferences: vi.fn<AdministrationPort['preferences']>().mockResolvedValue(base),
    savePreferences: vi.fn<AdministrationPort['savePreferences']>(),
  };
  const sync = createAccountPreferencesSync({ port, ownsAccount: () => owner, writable, publish });
  const unbind = host.bindAccountPreferences(sync.accept);
  return {
    host,
    publish,
    port,
    sync,
    end: () => {
      owner = false;
      unbind();
      sync.dispose();
      useShellStore.getState().applyAccountPreferences(undefined);
    },
  };
}

describe('账户偏好同步', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useShellStore.getState().applyAccountPreferences(undefined);
    useShellStore.getState().applyPersistedPreferences(defaultPreferences, false);
  });

  it('只在第一次明确账号动作后播种可同步字段', async () => {
    const { sync, host, port, end } = start();
    port.preferences.mockResolvedValueOnce({ ...base, version: 0, language: 'en-US' });
    port.savePreferences.mockResolvedValueOnce({ ...base, version: 1, themeMode: 'dark' });
    await sync.load();
    host.updateCategory('appearance', {
      accent: 'pink',
      density: 'comfortable',
      motion: 'standard',
    });
    await Promise.resolve();
    expect(port.savePreferences).not.toHaveBeenCalled();
    expect(host.getSnapshot().localeRegion.language).toBe('zh-CN');
    host.updateCategory('appearance', { themeMode: 'dark' });
    await vi.waitFor(() => expect(port.savePreferences).toHaveBeenCalledTimes(1));
    expect(port.savePreferences).toHaveBeenCalledWith(
      {
        version: 0,
        language: 'zh-CN',
        timeZone: '',
        themeMode: 'dark',
        notifications: { inApp: true },
      },
      expect.any(AbortSignal),
    );
    const stored = JSON.parse(window.localStorage.getItem('clouddrive.shell')!) as {
      state: { preferences: Preferences };
    };
    expect(stored.state.preferences.appearance).toMatchObject({
      themeMode: 'system',
      accent: 'pink',
      density: 'comfortable',
      motion: 'standard',
    });
    end();
    expect(host.getSnapshot().appearance.themeMode).toBe('system');
  });

  it('只读账号可显示服务端偏好并编辑设备设置', async () => {
    const { sync, host, publish, port, end } = start(false);
    await sync.load();
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ sharedReadOnly: true, editable: false }),
    );
    host.updateCategory('appearance', { themeMode: 'dark', density: 'comfortable' });
    expect(host.getSnapshot().appearance).toMatchObject({
      themeMode: 'light',
      density: 'comfortable',
    });
    expect(port.savePreferences).not.toHaveBeenCalled();
    expect(useShellStore.getState().devicePreferences.appearance.themeMode).toBe('system');
    end();
  });

  it('在单个请求进行时保留后续编辑，以返回版本逐个保存', async () => {
    const { sync, host, port, end } = start();
    const first = deferredPreferences();
    port.savePreferences.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
      ...base,
      version: 4,
      themeMode: 'dark',
      notifications: { ...base.notifications, dailySummary: true },
    });
    await sync.load();
    host.updateCategory('appearance', { themeMode: 'dark' });
    await vi.waitFor(() => expect(port.savePreferences).toHaveBeenCalledTimes(1));
    sync.updateNotification('dailySummary', true);
    expect(port.savePreferences).toHaveBeenCalledTimes(1);
    first.resolve({ ...base, version: 3, themeMode: 'dark' });
    await vi.waitFor(() => expect(port.savePreferences).toHaveBeenCalledTimes(2));
    expect(port.savePreferences.mock.calls.map(([value]) => value)).toEqual([
      { version: 2, themeMode: 'dark' },
      { version: 3, notifications: { dailySummary: true } },
    ]);
    end();
  });

  it('冲突时可放弃同字段编辑，仍保存独立变更', async () => {
    const { host, sync, publish, port, end } = start();
    port.preferences
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({ ...base, version: 3, themeMode: 'system' });
    port.savePreferences
      .mockRejectedValueOnce(new ApiError('http', 409))
      .mockResolvedValueOnce({ ...base, version: 4, themeMode: 'system', timeZone: 'Asia/Tokyo' });
    await sync.load();
    host.updateCategory('appearance', { themeMode: 'dark' });
    host.updateCategory('localeRegion', { timeZone: 'Asia/Tokyo' });
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ issue: 'conflict' })),
    );
    expect(host.getSnapshot().appearance.themeMode).toBe('dark');
    sync.dismiss();
    await vi.waitFor(() => expect(port.savePreferences).toHaveBeenCalledTimes(2));
    expect(port.savePreferences.mock.calls[1]?.[0]).toEqual({ version: 3, timeZone: 'Asia/Tokyo' });
    expect(host.getSnapshot().appearance.themeMode).toBe('system');
    end();
  });

  it('远端只改独立字段时以新版本保存本次更改', async () => {
    const { host, sync, port, end } = start();
    const updated = { ...base, version: 3, timeZone: 'Asia/Tokyo' };
    port.preferences.mockResolvedValueOnce(base).mockResolvedValueOnce(updated);
    port.savePreferences
      .mockRejectedValueOnce(new ApiError('http', 409))
      .mockResolvedValueOnce({ ...updated, version: 4, themeMode: 'dark' });
    await sync.load();
    host.updateCategory('appearance', { themeMode: 'dark' });
    await vi.waitFor(() => expect(port.savePreferences).toHaveBeenCalledTimes(2));
    expect(port.savePreferences.mock.calls[1]?.[0]).toEqual({ version: 3, themeMode: 'dark' });
    expect(host.getSnapshot().localeRegion.timeZone).toBe('Asia/Tokyo');
    end();
  });

  it('网络写入失败时保留待同步的有效值，重试仍使用已知版本', async () => {
    const { host, sync, port, publish, end } = start();
    port.savePreferences
      .mockRejectedValueOnce(new ApiError('network'))
      .mockResolvedValueOnce({ ...base, version: 3, language: 'en-US' });
    await sync.load();
    host.updateCategory('localeRegion', { language: 'en' });
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ issue: 'write' })),
    );
    expect(host.getSnapshot().localeRegion.language).toBe('en');
    expect(useShellStore.getState().devicePreferences.localeRegion.language).toBe('zh-CN');
    sync.retry();
    await vi.waitFor(() => expect(port.savePreferences).toHaveBeenCalledTimes(2));
    expect(port.savePreferences.mock.calls[1]?.[0]).toEqual({ version: 2, language: 'en-US' });
    end();
  });

  it('切换账号后取消请求并丢弃迟到响应', async () => {
    const { host, sync, port, end } = start();
    const first = deferredPreferences();
    port.savePreferences.mockReturnValueOnce(first.promise);
    await sync.load();
    host.updateCategory('appearance', { themeMode: 'dark' });
    await vi.waitFor(() => expect(port.savePreferences).toHaveBeenCalledTimes(1));
    const signal = port.savePreferences.mock.calls[0]?.[1] as AbortSignal;
    end();
    expect(signal.aborted).toBe(true);
    first.resolve({ ...base, version: 3, themeMode: 'dark' });
    await first.promise;
    expect(host.getSnapshot().appearance.themeMode).toBe('system');
    expect(useShellStore.getState().accountPreferences).toBeUndefined();
  });
});
