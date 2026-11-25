'use client';
import { useCallback, useLayoutEffect, useMemo, useContext, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { AuthContext, useAuth } from '../auth/context';
import {
  AccountNotificationSettingsContext,
  AdministrationProvider,
  type AccountNotificationSettings,
} from '@clouddrive/surface/administration/runtime';
import { readAuthConfig } from '../auth/config';
import { HostPreferencesContext } from '../host/preferences-port';
import { createLazyAdministrationPort } from './lazy-port';
import type { OwnedAccountNotificationSettings } from './preferences-sync';

const AccountPreferencesSync = dynamic(
  () => import('./preferences-sync').then((module) => module.AccountPreferencesSync),
  { ssr: false },
);

const loadingAccountSettings: AccountNotificationSettings = {
  values: null,
  editable: false,
  sharedReadOnly: false,
  sharedUnavailable: true,
  pending: false,
  update: () => undefined,
};

export function AdministrationRuntime({ children }: Readonly<{ children: ReactNode }>) {
  const controller = useContext(AuthContext);
  const preferences = useContext(HostPreferencesContext);
  const auth = useAuth();
  const currentOwner = useCallback(
    () => controller?.getState().session?.user.id ?? null,
    [controller],
  );
  const [accountSettings, setAccountSettings] = useState<OwnedAccountNotificationSettings | null>(
    null,
  );
  const port = useMemo(() => {
    const config = readAuthConfig();
    return config.mode === 'backend'
      ? createLazyAdministrationPort(config.apiBaseUrl, currentOwner)
      : null;
  }, [currentOwner]);
  const owner = port && !auth.session?.mustChangePassword ? auth.session?.user.id : undefined;
  useLayoutEffect(() => {
    if (!owner || !preferences) return;
    return preferences.waitForAccountPreferences(() => currentOwner() === owner);
  }, [owner, preferences, currentOwner]);
  const settings = owner
    ? accountSettings?.owner === owner
      ? accountSettings.settings
      : loadingAccountSettings
    : null;
  return (
    <AdministrationProvider port={port}>
      <AccountNotificationSettingsContext value={settings}>
        {port && owner ? (
          <AccountPreferencesSync
            key={owner}
            port={port}
            owner={owner}
            currentOwner={currentOwner}
            publish={setAccountSettings}
          />
        ) : null}
        {children}
      </AccountNotificationSettingsContext>
    </AdministrationProvider>
  );
}
