'use client';
import { useCallback, useMemo, useContext, useState, type ReactNode } from 'react';
import { AuthContext, useAuth } from '../auth/context';
import {
  AccountNotificationSettingsContext,
  AdministrationProvider,
} from '@clouddrive/surface/administration/runtime';
import { readAuthConfig } from '../auth/config';
import { createLazyAdministrationPort } from './lazy-port';
import type { OwnedAccountNotificationSettings } from './preferences-sync';
import dynamic from 'next/dynamic';
const AccountPreferencesSync = dynamic(
  () => import('./preferences-sync').then((module) => module.AccountPreferencesSync),
  { ssr: false },
);
export function AdministrationRuntime({ children }: Readonly<{ children: ReactNode }>) {
  const controller = useContext(AuthContext);
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
  const owner = !auth.session?.mustChangePassword ? auth.session?.user.id : undefined;
  return (
    <AdministrationProvider port={port}>
      <AccountNotificationSettingsContext
        value={accountSettings?.owner === owner ? (accountSettings?.settings ?? null) : null}
      >
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
