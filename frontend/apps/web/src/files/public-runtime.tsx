'use client';
import { lazy, Suspense, useContext } from 'react';
import { BusyIndicator } from '@neocloud/ui-adapter/busy-indicator';
import { AuthContext, useAuth } from '../auth/context';
import { AuthStatusSurface } from '../auth/status-surface';
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { PublicFilesProvider, type FileMediaProps } from '@neocloud/surface/files/runtime';
import { useFrontendTranslation } from '@neocloud/i18n';
import { Action } from '@neocloud/ui-adapter/action';
import { StateSurface } from '@neocloud/ui-adapter/state-surface';
import { Cloud } from 'lucide-react';
import { createPublicFilesRuntime } from './public-backend';
import { AppLoadingSurface } from '../host/app-loading-surface';
const PublicMediaView = lazy(() =>
  import('./media-view').then((module) => ({ default: module.FileMediaView })),
);
import { initializePublicFileMessages } from './messages';

export function PublicFilesRuntime({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useFrontendTranslation();
  const auth = useAuth(),
    controller = useContext(AuthContext);
  const account = auth.session?.user.id ?? null;
  const [messagesReady, setMessagesReady] = useState(false),
    [messagesFailed, setMessagesFailed] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void initializePublicFileMessages()
      .then(() => {
        if (active) setMessagesReady(true);
      })
      .catch(() => {
        if (active) setMessagesFailed(true);
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  const [token, setToken] = useState<string>();
  useEffect(() => {
    const synchronize = () =>
      setToken(new URLSearchParams(location.hash.slice(1)).get('token') ?? '');
    synchronize();
    window.addEventListener('hashchange', synchronize);
    return () => window.removeEventListener('hashchange', synchronize);
  }, []);
  const runtime = useMemo(
    () =>
      createPublicFilesRuntime(token ?? '', {
        subject: account,
        current: () => controller?.getState().session?.user.id ?? null,
      }),
    [token, controller, account],
  );
  const Media = useMemo(
    () =>
      function PublicMediaRenderer(props: FileMediaProps) {
        const { t } = useFrontendTranslation();
        return (
          <Suspense
            fallback={<BusyIndicator label={props.labels?.loading ?? t('publicFiles.loading')} />}
          >
            <PublicMediaView {...props} readContent={runtime.readMedia} />
          </Suspense>
        );
      },
    [runtime],
  );
  useLayoutEffect(() => {
    runtime.activate();
    return () => runtime.dispose();
  }, [runtime]);
  if (auth.status === 'idle' || auth.status === 'restoring' || auth.status === 'error')
    return <AuthStatusSurface />;
  if (messagesFailed)
    return (
      <main id="main-content" className="p-5">
        <StateSurface
          state="error"
          icon={<Cloud />}
          title={t('publicFiles.errors.unavailable')}
          description={t('publicFiles.loading')}
        />
        <Action
          variant="secondary"
          onPress={() => {
            setMessagesFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          {t('publicFiles.refresh')}
        </Action>
      </main>
    );
  if (token === undefined || !messagesReady)
    return <AppLoadingSurface label="正在读取分享 / Loading share" />;
  return (
    <PublicFilesProvider
      key={token + ':' + (account ?? 'anonymous')}
      port={runtime.port}
      media={Media}
    >
      {children}
    </PublicFilesProvider>
  );
}
