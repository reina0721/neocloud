import type { ReactNode } from 'react';
import { SystemUpdateEnvironmentProvider } from '@clouddrive/surface/administration/runtime';

export default function SystemUpdateLayout({ children }: Readonly<{ children: ReactNode }>) {
  const developmentEnvironment =
    process.env.NODE_ENV === 'development'
      ? process.platform === 'win32'
        ? 'windows-development'
        : 'development'
      : null;
  return (
    <SystemUpdateEnvironmentProvider environment={developmentEnvironment}>
      {children}
    </SystemUpdateEnvironmentProvider>
  );
}
