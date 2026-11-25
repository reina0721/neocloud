'use client';
import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { AlertBanner } from '@clouddrive/ui-adapter/feedback';
import { AlertTriangle } from 'lucide-react';
import { useProductAccess } from '@clouddrive/surface/identity/runtime';
import type { AdministrationPort } from '@clouddrive/surface/administration';
import type { AccountNotificationSettings } from '@clouddrive/surface/administration/runtime';
import { HostPreferencesContext } from '../host/preferences-port';
import { useShellStore } from '../state/use-shell-store';
import {
  createAccountPreferencesSync,
  type AccountPreferencesAccess,
  type AccountPreferencesStatus,
} from './preferences';

export type OwnedAccountNotificationSettings = Readonly<{
  owner: string;
  settings: AccountNotificationSettings;
}>;

export function AccountPreferencesSync({
  port,
  owner,
  currentOwner,
  publish,
}: Readonly<{
  port: AdministrationPort;
  owner: string;
  currentOwner: () => string | null;
  publish: (value: OwnedAccountNotificationSettings | null) => void;
}>) {
  // 同一账号重新确权时保留队列，收到结果后更新可读写范围。
  const access = useProductAccess({ retainDuringRefresh: true });
  const { t } = useFrontendTranslation();
  const host = useContext(HostPreferencesContext);
  const actor = useRef<ReturnType<typeof createAccountPreferencesSync> | null>(null);
  const reloadAccess = useRef(access.reload);
  const [notice, setNotice] = useState<{
    issue: NonNullable<AccountPreferencesStatus['issue']>;
    retry: () => void;
    dismiss: () => void;
  }>();
  const currentAccess = access.data?.user.id === owner ? access.data : null;
  const scopes = currentAccess?.nativePermissions;
  const accessMode: AccountPreferencesAccess = !currentAccess
    ? 'unavailable'
    : !scopes?.includes('iam:account:self:preferences:read')
      ? 'device'
      : scopes.includes('iam:account:self:preferences:write')
        ? 'writable'
        : 'read-only';

  useLayoutEffect(() => {
    reloadAccess.current = access.reload;
  }, [access.reload]);

  useLayoutEffect(() => {
    if (!host) return;
    const ownsAccount = () => currentOwner() === owner;
    const controller = createAccountPreferencesSync({
      port,
      ownsAccount,
      refreshAccess: () => reloadAccess.current(),
      publish: ({ issue, ...status }) => {
        setNotice(
          issue ? { issue, retry: controller.retry, dismiss: controller.dismiss } : undefined,
        );
        publish({ owner, settings: { ...status, update: controller.updateNotification } });
      },
    });
    actor.current = controller;
    const unbind = host.bindAccountPreferences(controller.accept);
    window.addEventListener('focus', controller.refresh);
    return () => {
      actor.current = null;
      unbind();
      controller.dispose();
      window.removeEventListener('focus', controller.refresh);
      if (ownsAccount()) useShellStore.getState().applyAccountPreferences(undefined);
      publish(null);
    };
  }, [currentOwner, host, owner, port, publish]);

  useLayoutEffect(() => {
    actor.current?.setAccess(accessMode);
    actor.current?.refresh();
  }, [accessMode, currentOwner, host, owner, port, publish]);

  const alert = access.error ? { issue: 'access' as const, retry: access.reload } : notice;
  return alert ? (
    <div className="mx-auto max-w-screen-2xl px-4 pt-4">
      <AlertBanner
        actionLabel={t(
          alert.issue === 'conflict'
            ? 'administration.preferencesOverwrite'
            : 'administration.retry',
        )}
        onAction={alert.retry}
        {...('dismiss' in alert
          ? { dismissLabel: t('administration.preferencesDiscard'), onDismiss: alert.dismiss }
          : {})}
        announcement="polite"
        tone="warning"
        title={t(`administration.preferencesSyncIssue.${alert.issue}.title`)}
        description={t(`administration.preferencesSyncIssue.${alert.issue}.hint`)}
        icon={<AlertTriangle aria-hidden="true" />}
      />
    </div>
  ) : null;
}
