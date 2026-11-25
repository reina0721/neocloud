'use client';
/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type ReactNode } from 'react';
import type { AccountNotificationPreferences, AdministrationPort } from './model';
export {
  CurrentSiteLogo,
  publishedSiteOrigin,
  SiteProfileProvider,
  useSiteProfile,
} from './site-profile-runtime';
const Context = createContext<AdministrationPort | null>(null);

export type AccountNotificationSettings = Readonly<{
  values: AccountNotificationPreferences | null;
  editable: boolean;
  sharedReadOnly: boolean;
  sharedUnavailable: boolean;
  pending: boolean;
  update: (field: keyof AccountNotificationPreferences, value: boolean) => void;
}>;

export const AccountNotificationSettingsContext = createContext<AccountNotificationSettings | null>(
  null,
);

export function useAccountNotificationSettings() {
  return useContext(AccountNotificationSettingsContext);
}

export function AdministrationProvider({
  port,
  children,
}: Readonly<{ port: AdministrationPort | null; children: ReactNode }>) {
  return <Context value={port}>{children}</Context>;
}
export function useAdministration() {
  return useContext(Context);
}
export function useRequiredAdministration(): AdministrationPort {
  const port = useAdministration();
  if (!port) throw new Error('Backend administration is required');
  return port;
}
