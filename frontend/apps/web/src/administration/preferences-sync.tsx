'use client';
import { useContext, useLayoutEffect, useState } from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { AlertBanner } from '@clouddrive/ui-adapter/feedback';
import { AlertTriangle } from 'lucide-react';
import { useProductAccess } from '@clouddrive/surface/identity/runtime';
import type { AdministrationPort } from '@clouddrive/surface/administration';
import type { AccountNotificationSettings } from '@clouddrive/surface/administration/runtime';
import { HostPreferencesContext } from '../host/preferences-port';
import { useShellStore } from '../state/use-shell-store';
import { createAccountPreferencesSync, type AccountPreferencesStatus } from './preferences';

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
  // 重新读取同一账号权限期间保留当前写入队列，拒绝或失败后卸载该作用域。
  const access = useProductAccess({ retainDuringRefresh: true });
  const { t } = useFrontendTranslation();
  const host = useContext(HostPreferencesContext);
  const [notice, setNotice] = useState<{
    issue: NonNullable<AccountPreferencesStatus['issue']>;
    retry: () => void;
    dismiss: () => void;
  }>();
  const currentAccess = access.data?.user.id === owner ? access.data.nativePermissions : undefined;
  const readable = currentAccess?.includes('iam:account:self:preferences:read') ?? false;
  const writable = currentAccess?.includes('iam:account:self:preferences:write') ?? false;

  useLayoutEffect(() => {
    if (!readable || !host) return;
    const ownsAccount = () => currentOwner() === owner;
    const controller = createAccountPreferencesSync({
      port,
      ownsAccount,
      writable,
      publish: ({ issue, ...status }) => {
        setNotice(
          issue ? { issue, retry: controller.retry, dismiss: controller.dismiss } : undefined,
        );
        publish({ owner, settings: { ...status, update: controller.updateNotification } });
      },
    });
    const unbind = host.bindAccountPreferences(controller.accept);
    publish({
      owner,
      settings: {
        values: null,
        editable: writable,
        sharedReadOnly: !writable,
        pending: false,
        update: controller.updateNotification,
      },
    });
    void controller.load();
    window.addEventListener('focus', controller.refresh);
    return () => {
      unbind();
      controller.dispose();
      window.removeEventListener('focus', controller.refresh);
      if (ownsAccount()) useShellStore.getState().applyAccountPreferences(undefined);
      publish(null);
    };
  }, [currentOwner, host, owner, port, publish, readable, writable]);

  return readable && notice ? (
    <div className="mx-auto max-w-screen-2xl px-4 pt-4">
      <AlertBanner
        actionLabel={t(
          notice.issue === 'conflict'
            ? 'administration.preferencesOverwrite'
            : 'administration.retry',
        )}
        onAction={notice.retry}
        dismissLabel={t('administration.preferencesDiscard')}
        onDismiss={notice.dismiss}
        announcement="polite"
        tone="warning"
        title={t(`administration.preferencesSyncIssue.${notice.issue}.title`)}
        description={t(`administration.preferencesSyncIssue.${notice.issue}.hint`)}
        icon={<AlertTriangle aria-hidden="true" />}
      />
    </div>
  ) : null;
}
