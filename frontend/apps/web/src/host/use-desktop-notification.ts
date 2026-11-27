'use client';
import { useContext, useEffect, useEffectEvent, useRef, useState } from 'react';
import { useFrontendTranslation } from '@neocloud/i18n';
import { usePreferencesPort } from '@neocloud/plugin-framework/preferences';
import type { Preferences } from '@neocloud/surface/preferences-model';
import { AuthContext } from '../auth/context';
import { useShellStore } from '../state/use-shell-store';
import { useNotificationsStore } from '../state/use-notifications-store';
/** 请求桌面通知权限；返回最终状态（granted / denied / unsupported）。 */
export async function requestDesktopNotificationPermission(): Promise<
  'granted' | 'denied' | 'unsupported'
> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const result = await Notification.requestPermission();
    return result === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

/** 在认证壳内复用设备授权，权限弹窗由设置开关的用户操作触发。 */
export function useDesktopNotificationSettings(owner: string | null) {
  const { t } = useFrontendTranslation();
  const auth = useContext(AuthContext);
  const preferences = usePreferencesPort<Preferences>();
  const enabled = useShellStore((state) => state.preferences.notifications.desktopNotifications);
  const operation = useRef<symbol | null>(null);
  const [pendingOwner, setPendingOwner] = useState<string | null>(null);

  function warn(status: 'denied' | 'unsupported') {
    useNotificationsStore.getState().publish({
      category: 'warning',
      severity: 'notice',
      title: t('shell.desktopNotificationDeniedTitle'),
      description:
        status === 'unsupported'
          ? t('shell.desktopNotificationUnsupported')
          : t('shell.desktopNotificationDenied'),
    });
  }

  const reconcile = useEffectEvent(() => {
    if (!owner || !preferences.getSnapshot().notifications.desktopNotifications) return;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') return;
    preferences.updateCategory('notifications', { desktopNotifications: false });
    warn(typeof Notification === 'undefined' ? 'unsupported' : 'denied');
  });
  useEffect(() => {
    if (!enabled || !owner) return;
    reconcile();
    const onFocus = () => reconcile();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled, owner]);
  useEffect(
    () => () => {
      operation.current = null;
    },
    [],
  );

  return {
    pending: owner !== null && owner === pendingOwner,
    setEnabled(next: boolean, save: (allowed: boolean) => void) {
      if (!owner || owner !== auth?.getState().session?.user.id) return;
      if (!next) {
        operation.current = null;
        setPendingOwner(null);
        save(false);
        return;
      }
      const current = Symbol();
      operation.current = current;
      setPendingOwner(owner);
      void requestDesktopNotificationPermission().then((status) => {
        if (operation.current !== current) return;
        operation.current = null;
        setPendingOwner(null);
        if (auth.getState().session?.user.id !== owner) return;
        save(status === 'granted');
        if (status !== 'granted') warn(status);
      });
    },
  };
}
