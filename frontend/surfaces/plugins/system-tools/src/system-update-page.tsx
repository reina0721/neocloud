'use client';

import { useCallback } from 'react';
import { FrontendMessages, useFrontendTranslation } from '@clouddrive/i18n';
import { Page, PageHeader, Section } from '@clouddrive/surface-foundation/layout';
import { Action } from '@clouddrive/ui-adapter/action';
import { StateSurface } from '@clouddrive/ui-adapter/state-surface';
import { StatusPill } from '@clouddrive/ui-adapter/status-pill';
import {
  useRequiredAdministration,
  useSystemUpdateEnvironment,
} from '../../../src/administration/context';
import { useProductAccess } from '../../../src/identity/use-access';
import { NavigationIcon } from '../../../src/navigation-icon-presentation';
import { systemUpdateMessages } from './system-update-messages';
import { useCatalogRequest } from './use-catalog-request';

function UpdateDetails() {
  const { t } = useFrontendTranslation();
  const { runtime } = useRequiredAdministration();
  const environment = useSystemUpdateEnvironment();
  const readStatus = useCallback(
    async (signal: AbortSignal) => environment ?? runtime.maintenanceAccess(signal),
    [environment, runtime],
  );
  const status = useCatalogRequest(readStatus);
  const build = useCatalogRequest(runtime.build);
  const access = status.result && 'value' in status.result ? status.result.value : null;
  return (
    <>
      <Section title={t('systemUpdate.version')} density="compact" contentInset>
        {!build.result ? (
          <p role="status">{t('administration.loading')}</p>
        ) : 'value' in build.result ? (
          <p className="break-all text-sm font-medium tabular-nums">{build.result.value.version}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <p role="status">{t('systemUpdate.versionUnavailable')}</p>
            <Action variant="quiet" size="sm" onPress={build.refresh}>
              {t('administration.retry')}
            </Action>
          </div>
        )}
      </Section>
      <Section title={t('systemUpdate.operations')} density="compact" contentInset>
        <div className="space-y-2 text-sm">
          {access === 'owner-verified' ? (
            <>
              <p>{t('systemUpdate.status.owner-verified')}</p>
              <a className="inline-block font-medium text-brand underline" href="/maintenance">
                {t('systemUpdate.open')}
              </a>
            </>
          ) : (
            <>
              <StatusPill tone="neutral">{t('systemUpdate.disabled')}</StatusPill>
              <p role="status" className="text-ink-muted">
                {access
                  ? t(`systemUpdate.status.${access}`)
                  : status.result
                    ? t('systemUpdate.statusUnavailable')
                    : t('administration.loading')}
              </p>
              <div className="flex flex-wrap gap-2">
                {['check', 'upgrade', 'rollback', 'restore'].map((action) => (
                  <Action key={action} variant="secondary" size="sm" disabled>
                    {t(`systemUpdate.${action}`)}
                  </Action>
                ))}
                {status.result && 'error' in status.result ? (
                  <Action variant="quiet" size="sm" onPress={status.refresh}>
                    {t('administration.retry')}
                  </Action>
                ) : null}
              </div>
            </>
          )}
        </div>
      </Section>
    </>
  );
}

function UpdateContent() {
  const { t } = useFrontendTranslation();
  const access = useProductAccess();
  const title = t('systemUpdate.title');
  return (
    <Page>
      <PageHeader title={title} description={t('systemUpdate.description')} />
      {access.loading ? (
        <p role="status">{t('administration.loading')}</p>
      ) : access.data?.nativePermissions?.includes('management:read') ? (
        <UpdateDetails />
      ) : (
        <StateSurface
          compact
          state="warning"
          icon={<NavigationIcon iconId="settings" />}
          title={t(`identityProduct.errors.${access.error?.code ?? 'forbidden'}`)}
          description={t(
            access.error ? 'administration.failureDescription' : 'systemUpdate.accessHint',
          )}
          {...(access.error
            ? { actionLabel: t('administration.retry'), onAction: access.reload }
            : {})}
        />
      )}
    </Page>
  );
}

export function SystemUpdatePage() {
  const { t } = useFrontendTranslation();
  return (
    <FrontendMessages
      resources={systemUpdateMessages}
      fallback={<p role="status">{t('administration.loading')}</p>}
    >
      <UpdateContent />
    </FrontendMessages>
  );
}
