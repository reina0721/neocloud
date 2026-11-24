'use client';
import { useEffect, useRef, useState } from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { AlertBanner } from '@clouddrive/ui-adapter/feedback';
import { AlertTriangle } from 'lucide-react';
import { useProductAccess } from '@clouddrive/surface/identity/runtime';
import type { AccountPreferences, AdministrationPort } from '@clouddrive/surface/administration';
import type { Preferences } from '@clouddrive/surface/preferences-model';
import { ApiError } from '../api/json-client';
import { useShellStore } from '../state/use-shell-store';
import { applyAccountPreferences } from './preferences';

function mapLocalToAccountPatch(
  local: Preferences,
  server: AccountPreferences,
): AccountPreferences | null {
  const language: AccountPreferences['language'] =
    local.localeRegion.language === 'en' ? 'en-US' : 'zh-CN';
  const timeZone = local.localeRegion.timeZone === 'auto' ? '' : local.localeRegion.timeZone;
  const themeMode = local.appearance.themeMode;
  const themePreset: AccountPreferences['themePreset'] =
    local.appearance.accent === 'purple'
      ? 'violet'
      : local.appearance.accent === 'pink'
        ? server.themePreset
        : local.appearance.accent;
  const density: AccountPreferences['density'] =
    local.appearance.density === 'compact' ? 'compact' : 'comfortable';
  const reduceMotion = local.appearance.motion === 'reduced';
  const inApp = local.notifications.inAppNotifications;

  if (
    server.language === language &&
    server.timeZone === timeZone &&
    server.themeMode === themeMode &&
    server.themePreset === themePreset &&
    server.density === density &&
    server.reduceMotion === reduceMotion &&
    server.notifications.inApp === inApp
  ) {
    return null;
  }

  return {
    ...server,
    language,
    timeZone,
    themeMode,
    themePreset,
    density,
    reduceMotion,
    notifications: { ...server.notifications, inApp },
  };
}

export function AccountPreferencesSync({ port }: Readonly<{ port: AdministrationPort }>) {
  const access = useProductAccess();
  const { t } = useFrontendTranslation();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const serverRef = useRef<AccountPreferences | null>(null);
  const syncingRef = useRef(false);
  const writeBlockedRef = useRef(false);
  const allowed =
    access.data?.nativePermissions?.includes('iam:account:self:preferences:read') ?? false;
  const canWrite =
    access.data?.nativePermissions?.includes('iam:account:self:preferences:write') ?? false;

  useEffect(() => {
    if (!allowed) return;
    let active = true;
    void port.preferences().then(
      (value) => {
        if (!active) return;
        setFailed(false);
        serverRef.current = value;
        if (value.version > 0) {
          syncingRef.current = true;
          applyAccountPreferences(value);
          queueMicrotask(() => {
            syncingRef.current = false;
          });
        }
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [port, allowed, retry]);

  useEffect(() => {
    if (!allowed || !canWrite) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useShellStore.subscribe((state) => {
      if (syncingRef.current || writeBlockedRef.current || !serverRef.current) return;
      const next = mapLocalToAccountPatch(state.preferences, serverRef.current);
      if (!next) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const latest = serverRef.current;
        if (!latest || writeBlockedRef.current) return;
        const payload = mapLocalToAccountPatch(useShellStore.getState().preferences, latest);
        if (!payload) return;
        syncingRef.current = true;
        void port
          .savePreferences(payload)
          .then((saved) => {
            serverRef.current = saved;
          })
          .catch((error: unknown) => {
            if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
              writeBlockedRef.current = true;
            }
            // 本地已生效；后端同步失败不打断界面操作，等待下次保存或刷新同步。
          })
          .finally(() => {
            queueMicrotask(() => {
              syncingRef.current = false;
            });
          });
      }, 600);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [port, allowed, canWrite]);

  return failed ? (
    <AlertBanner
      actionLabel={t('administration.retry')}
      onAction={() => setRetry((value) => value + 1)}
      tone="warning"
      title={t('administration.preferencesLoadFailure')}
      description={t('administration.failureDescription')}
      icon={<AlertTriangle aria-hidden="true" />}
    />
  ) : null;
}
