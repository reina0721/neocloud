'use client';

import { useState, useSyncExternalStore } from 'react';
import ReactMarkdown from 'react-markdown';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { formatInstant } from '@clouddrive/i18n/format';
import { usePreferencesPort } from '@clouddrive/plugin-framework/preferences';
import { Section } from '@clouddrive/surface-foundation/layout';
import { Action } from '@clouddrive/ui-adapter/action';
import { DisclosurePanel } from '@clouddrive/ui-adapter/disclosure';
import { RuntimeReadError, type ReleaseCatalog } from '../../../src/administration/runtime-model';
import { formatFileBytes } from '../../../src/files/format';
import type { Preferences } from '../../../src/preferences-model';
import { useCatalogRequest } from './use-catalog-request';

const releasePage = 'https://github.com/reina0721/neocloud/releases/latest';

function ReleaseDetails({ release }: { release: ReleaseCatalog }) {
  const { t, locale } = useFrontendTranslation();
  const preferences = usePreferencesPort<Preferences>();
  const { localeRegion } = useSyncExternalStore(
    preferences.subscribe,
    preferences.getSnapshot,
    preferences.getSnapshot,
  );
  return (
    <>
      <p role="status" className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <strong>{t('systemUpdate.release.latest', { version: release.version })}</strong>
        <time dateTime={release.publishedAt} className="text-ink-muted">
          {formatInstant(locale, localeRegion, release.publishedAt)}
        </time>
      </p>
      <DisclosurePanel title={t('systemUpdate.release.notes')}>
        {release.notes.trim() ? (
          <div className="space-y-2 wrap-anywhere [&_h2]:font-semibold [&_h3]:font-semibold [&_ul]:list-inside [&_ul]:list-disc [&_ol]:list-inside [&_ol]:list-decimal [&_pre]:overflow-auto [&_pre]:rounded-control [&_pre]:bg-surface-muted [&_pre]:p-2">
            <ReactMarkdown
              skipHtml
              disallowedElements={['img']}
              urlTransform={(url) => (url.startsWith('https://github.com/') ? url : '')}
              components={{
                a: ({ href, children }) =>
                  href ? (
                    <a
                      className="text-brand underline"
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {children}
                    </a>
                  ) : (
                    <span>{children}</span>
                  ),
              }}
            >
              {release.notes}
            </ReactMarkdown>
          </div>
        ) : (
          <p>{t('systemUpdate.release.noNotes')}</p>
        )}
      </DisclosurePanel>
      <section className="space-y-1">
        <h3 className="font-semibold">{t('systemUpdate.release.assets')}</h3>
        {release.assets.length ? (
          <ul className="divide-y divide-border">
            {release.assets.map((asset) => (
              <li key={asset.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <a
                  className="min-w-0 break-all font-medium text-brand underline"
                  href={asset.downloadUrl}
                  referrerPolicy="no-referrer"
                >
                  {asset.name}
                </a>
                <span className="text-ink-muted">{formatFileBytes(asset.sizeBytes)}</span>
                {asset.kind !== 'other' ? (
                  <span className="text-ink-muted">
                    {t(
                      asset.kind === 'windows-backend'
                        ? 'systemUpdate.release.windowsBackend'
                        : 'systemUpdate.release.managedFull',
                    )}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">{t('systemUpdate.release.noAssets')}</p>
        )}
      </section>
    </>
  );
}

export function GitHubReleaseSection({
  load,
}: Readonly<{ load: (signal: AbortSignal) => Promise<ReleaseCatalog> }>) {
  const { t } = useFrontendTranslation();
  const [requested, setRequested] = useState(false);
  const { result, refresh } = useCatalogRequest(load, requested);
  const pending = requested && !result;
  const release = result && 'value' in result ? result.value : null;
  const error = result && 'error' in result ? result.error : null;
  const errorCode = error instanceof RuntimeReadError ? error.code : 'unavailable';
  return (
    <Section title={t('systemUpdate.release.title')} density="compact" contentInset>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Action
            variant="secondary"
            size="sm"
            loading={pending}
            onPress={() => (requested ? refresh() : setRequested(true))}
          >
            {t('systemUpdate.release.check')}
          </Action>
          <a
            className="font-medium text-brand underline"
            href={release?.releaseUrl ?? releasePage}
            target="_blank"
            rel="noreferrer"
          >
            {t('systemUpdate.release.open')}
          </a>
        </div>
        {pending ? <p role="status">{t('systemUpdate.release.loading')}</p> : null}
        {result && 'error' in result ? (
          <p role="status" className="text-ink-muted">
            {t(`systemUpdate.release.errors.${errorCode}`, {
              defaultValue: t('systemUpdate.release.errors.unavailable'),
            })}
          </p>
        ) : null}
        {release ? <ReleaseDetails release={release} /> : null}
      </div>
    </Section>
  );
}
