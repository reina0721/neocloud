import type { ReactNode } from 'react';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter';
import { MaterialThemeProvider } from '@clouddrive/ui-adapter/theme-provider';
import { SkipLink } from '@clouddrive/ui-adapter/accessibility';

import { AppErrorBoundary } from '../host/error-boundary';
import { AppProviders } from '../host/providers';
import { AuthProvider } from '../auth/provider';
import '../styles.css';

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN" data-theme="light" data-ui-system="kira">
      <body>
        <AppRouterCacheProvider options={{ key: 'kira', enableCssLayer: true }}>
          <MaterialThemeProvider>
            <AppErrorBoundary>
              <AppProviders>
                <AuthProvider>
                  <SkipLink href="#main-content" label="跳到主要内容 / Skip to content" />
                  {children}
                </AuthProvider>
              </AppProviders>
            </AppErrorBoundary>
          </MaterialThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
