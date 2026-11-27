'use client';

import { useEffect, useState } from 'react';
import { useFrontendTranslation } from '@neocloud/i18n';
import { AlertBanner } from '@neocloud/ui-adapter/feedback';
import { RotateCw } from 'lucide-react';

import { compatibleEnv } from '../../runtime/environment.mjs';

const loadedBuild = compatibleEnv(
  'NEXT_PUBLIC_NEOCLOUD_WEB_BUILD_ID',
  process.env.NEXT_PUBLIC_NEOCLOUD_WEB_BUILD_ID,
  process.env.NEXT_PUBLIC_CLOUDDRIVE_WEB_BUILD_ID,
);

/** Go 托管的静态页面显示部署更新提醒，用户可在保存后自行刷新。 */
export function WebBuildNotice() {
  const { t } = useFrontendTranslation();
  const [currentBuild, setCurrentBuild] = useState<string>();
  const [dismissedBuild, setDismissedBuild] = useState<string>();

  useEffect(() => {
    if (!loadedBuild) return;
    let pending: AbortController | undefined;
    function check() {
      if (pending || document.visibilityState !== 'visible') return;
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      void fetch('/api/host/v1/web-build', {
        cache: 'no-store',
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) return;
          const result = (await response.json()) as unknown;
          if (
            !controller.signal.aborted &&
            result &&
            typeof result === 'object' &&
            'buildId' in result &&
            typeof result.buildId === 'string' &&
            /^[a-f0-9]{40}$/.test(result.buildId)
          ) {
            setCurrentBuild(result.buildId);
          }
        })
        .catch(() => {
          // 维护中的临时失败留待下次检查，当前页面继续使用。
        })
        .finally(() => {
          window.clearTimeout(timeout);
          pending = undefined;
        });
    }
    check();
    const interval = window.setInterval(check, 60_000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      pending?.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  if (!currentBuild || currentBuild === loadedBuild || currentBuild === dismissedBuild) return null;
  return (
    <div className="fixed inset-x-3 top-16 z-sticky sm:left-auto sm:right-4 sm:max-w-sm">
      <AlertBanner
        actionLabel={t('common.reload')}
        announcement="polite"
        description={t('shell.webBuildUpdateDescription')}
        dismissLabel={t('common.close')}
        icon={<RotateCw aria-hidden="true" className="size-4" />}
        onAction={() => window.location.reload()}
        onDismiss={() => setDismissedBuild(currentBuild)}
        title={t('shell.webBuildUpdateTitle')}
      />
    </div>
  );
}
