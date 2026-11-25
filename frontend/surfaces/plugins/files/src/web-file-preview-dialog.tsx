'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { publishedSiteOrigin, useSiteProfile } from '@clouddrive/surface/administration/runtime';
import { Action } from '@clouddrive/ui-adapter/action';
import { HiddenField } from '@clouddrive/ui-adapter/form-field';
import { ReaderSurface } from './reader-surface';
import {
  maxWOPIEditBytes,
  fileApplicationDevice,
  type FileApplicationID,
  type WebFileApplicationItem,
} from '../../../src/files/file-applications';
import { fileIconExtension } from '../../../src/files/icon-rules';
import { FilesError, type FileEntry } from '../../../src/files/model';
import { useFiles } from '../../../src/files/runtime';
import { webFilePreviewURL } from '../../../src/files/web-file-preview';
import { makeReaderSession, readerApplications, readReaderLimits } from './file-reader-session';
import type { OpenReaderSession } from './file-reader-session';

type PreviewTarget = {
  url: string;
  newTab: boolean;
  wopi?: { token: string; expiresAtMilliseconds: number };
};

function WOPILaunch({
  target,
  title,
  newTabLabel,
}: {
  target: PreviewTarget & { wopi: NonNullable<PreviewTarget['wopi']> };
  title: string;
  newTabLabel: string;
}) {
  const frameName = useId();
  const embeddedForm = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);
  useEffect(() => {
    if (embeddedForm.current && !submitted.current) {
      submitted.current = true;
      embeddedForm.current.submit();
    }
  }, []);
  const credentials = (
    <>
      <HiddenField name="access_token" value={target.wopi.token} />
      <HiddenField name="access_token_ttl" value={target.wopi.expiresAtMilliseconds} />
    </>
  );
  return (
    <>
      <form method="post" action={target.url} target="_blank" rel="noopener noreferrer">
        {credentials}
        <Action type="submit" variant="secondary">
          {newTabLabel}
        </Action>
      </form>
      {!target.newTab ? (
        <>
          <iframe
            name={frameName}
            title={title}
            sandbox="allow-forms allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            className="min-h-0 w-full flex-1 border-0"
          />
          <form ref={embeddedForm} method="post" action={target.url} target={frameName}>
            {credentials}
          </form>
        </>
      ) : null}
    </>
  );
}

export function WebFilePreviewDialog({
  entry,
  application,
  onClose,
  replaceWithBuiltIn,
}: {
  entry: FileEntry;
  application: WebFileApplicationItem;
  onClose: () => void;
  replaceWithBuiltIn: (application: FileApplicationID, session: OpenReaderSession) => void;
}) {
  const port = useFiles();
  const { readPublishedAddresses } = useSiteProfile();
  const { locale, t } = useFrontendTranslation();
  const zh = locale.startsWith('zh');
  const [target, setTarget] = useState<PreviewTarget>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unverified, setUnverified] = useState(false);
  const [canUseFallback, setCanUseFallback] = useState(false);
  const request = useRef<AbortController>(null);
  useEffect(() => () => request.current?.abort(), []);
  const oversized = application.maxBytes > 0 && entry.sizeBytes > application.maxBytes;
  const editable = application.editExtensions?.includes(fileIconExtension(entry.name));
  const canEdit = editable && entry.sizeBytes <= maxWOPIEditBytes;
  async function launch(mode?: 'edit') {
    if (request.current || !application.origin || oversized) return;
    setLoading(true);
    setError('');
    const controller = new AbortController();
    request.current = controller;
    try {
      const currentOrigin = window.location.origin;
      const addresses = await readPublishedAddresses?.(controller.signal);
      const callbackOrigin = publishedSiteOrigin(addresses, currentOrigin, 'callback');
      const applicationOrigin = new URL(application.origin).origin;
      if (applicationOrigin === currentOrigin || applicationOrigin === callbackOrigin)
        throw new FilesError('unsupported');
      if (application.protocol !== 'wopi') {
        const readiness = port.checkWebFilePreview
          ? await port.checkWebFilePreview(application.id, controller.signal)
          : 'unverified';
        controller.signal.throwIfAborted();
        if (readiness === 'denied' || readiness === 'unavailable') {
          setCanUseFallback(true);
          setError(t(`files.webPreview.${readiness}`));
          return;
        }
        if (readiness === 'unverified' && !unverified) {
          setUnverified(true);
          setCanUseFallback(true);
          return;
        }
      }
      const preview = await port.launchWebFilePreview(entry, application, controller.signal, mode);
      if (preview.origin !== application.origin) throw new FilesError('conflict');
      if (application.protocol === 'wopi') {
        if (!preview.wopi) throw new FilesError('unavailable');
        const action = new URL(preview.wopi.actionUrl);
        if (
          action.protocol !== 'https:' ||
          action.origin !== new URL(preview.origin).origin ||
          action.username ||
          action.password
        )
          throw new FilesError('unsupported');
        const source = new URL('/wopi/files/' + encodeURIComponent(entry.id), callbackOrigin);
        action.searchParams.set('WOPISrc', source.href);
        if (!controller.signal.aborted)
          setTarget({
            url: action.href,
            newTab: preview.newTab,
            wopi: {
              token: preview.token,
              expiresAtMilliseconds: preview.wopi.expiresAtMilliseconds,
            },
          });
        return;
      }
      const url = webFilePreviewURL(
        preview,
        callbackOrigin,
        document.documentElement.dataset.theme === 'dark',
      );
      if (!controller.signal.aborted) setTarget({ url, newTab: preview.newTab });
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(t(`files.errors.${cause instanceof FilesError ? cause.code : 'unavailable'}`));
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function openBuiltIn() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const [policy, limits] = await Promise.all([
        port.readActiveFileApplications(controller.signal),
        readReaderLimits(port, controller.signal),
      ]);
      controller.signal.throwIfAborted();
      const { choice } = readerApplications(
        policy,
        entry,
        fileApplicationDevice(window.innerWidth),
      );
      const id = choice.options.find((option) => option !== 'drawio');
      const session = id && makeReaderSession(entry, id, limits);
      if (!id || !session) throw new FilesError('unsupported');
      replaceWithBuiltIn(id, session);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(t(`files.errors.${cause instanceof FilesError ? cause.code : 'unavailable'}`));
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <ReaderSurface
      isOpen
      title={application.name}
      triggerLabel={application.name}
      description={application.name}
      cancelLabel={t('files.close')}
      {...(target && !target.newTab ? { size: 'cover', layout: 'workspace' } : {})}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div
        className={target && !target.newTab ? 'flex h-full min-h-0 flex-col gap-3' : 'space-y-4'}
      >
        <p>
          {zh ? '接收文件的站点' : 'File recipient'} <strong>{application.origin}</strong>
        </p>
        {!target ? (
          <>
            <p>
              {zh
                ? '继续后，此站点可通过五分钟有效的地址读取当前文件内容。'
                : 'Continuing allows this site to read the current file through a link valid for five minutes.'}
            </p>
            {oversized ? (
              <p role="alert">
                {zh
                  ? '文件超过此应用的大小限制。'
                  : 'The file exceeds this application’s size limit.'}
              </p>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
            {unverified ? <p role="status">{t('files.webPreview.unverified')}</p> : null}
            <Action
              disabled={loading || oversized || !application.origin}
              loading={loading}
              onPress={() => void launch()}
            >
              {unverified
                ? t('files.webPreview.continueUnverified')
                : zh
                  ? '允许并继续'
                  : 'Allow and continue'}
            </Action>
            {canUseFallback ? (
              <Action variant="secondary" disabled={loading} onPress={() => void openBuiltIn()}>
                {t('files.webPreview.openBuiltIn')}
              </Action>
            ) : null}
            {editable ? (
              <>
                <p className="text-sm text-ink-muted">
                  {zh
                    ? '编辑会允许该站点在两小时内保存此文件的新版本，单次保存最多 8 MiB。'
                    : 'Editing allows this site to save new versions of this file for two hours, up to 8 MiB per save.'}
                </p>
                <Action
                  variant="secondary"
                  disabled={loading || oversized || !canEdit || !application.origin}
                  onPress={() => void launch('edit')}
                >
                  {zh ? '允许编辑' : 'Allow editing'}
                </Action>
              </>
            ) : null}
          </>
        ) : target.wopi ? (
          <WOPILaunch
            target={{ ...target, wopi: target.wopi }}
            title={application.name}
            newTabLabel={zh ? '在新标签页打开' : 'Open in a new tab'}
          />
        ) : (
          <>
            {!target.newTab ? (
              <iframe
                title={application.name}
                src={target.url}
                sandbox="allow-forms allow-scripts allow-same-origin"
                referrerPolicy="no-referrer"
                className="min-h-0 w-full flex-1 border-0"
              />
            ) : null}
            <a
              href={target.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand underline"
            >
              {zh ? '在新标签页打开' : 'Open in a new tab'}
            </a>
          </>
        )}
      </div>
    </ReaderSurface>
  );
}
