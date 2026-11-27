'use client';
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { useFrontendTranslation } from '@neocloud/i18n';
import { Action } from '@neocloud/ui-adapter/action';
import { IconAction } from '@neocloud/ui-adapter/icon-action';
import { MenuButton } from '@neocloud/ui-adapter/menu-button';
import { DialogSurface, type DialogSurfaceProps } from '@neocloud/ui-adapter/overlays';
import { ArrowLeft, Download, MoreHorizontal } from '../../../src/files/icons';
import { useReaderSurface } from './reader-surface-context';

/** 同页阅读区由工作区拥有。新建文件仍使用独立对话框。 */
export function ReaderSurface(props: DialogSurfaceProps) {
  const session = useReaderSurface();
  return session ? <ReaderPane {...props} session={session} /> : <DialogSurface {...props} />;
}

function ReaderPane({
  description,
  children,
  cancelLabel,
  headerAction,
  footerAction,
  busy,
  onOpenChange,
  onConfirm,
  confirmLabel,
  confirmDisabled,
  failureMessage,
  session,
}: DialogSurfaceProps & { session: NonNullable<ReturnType<typeof useReaderSurface>> }) {
  const { t } = useFrontendTranslation();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const sequence = useRef(session.closeSequence);
  function close() {
    if (!busy && !submitting.current) {
      if (session.requestInterceptedClose()) return;
      if (onOpenChange) onOpenChange(false);
      else session.close();
    }
  }
  const requestClose = useEffectEvent(close);
  useEffect(() => {
    if (sequence.current === session.closeSequence) return;
    sequence.current = session.closeSequence;
    requestClose();
  }, [session.closeSequence]);
  const foreground = session.presentation === 'reader';
  const mini = session.presentation === 'mini';
  const blocked = Boolean(busy || pending);
  const draftMessage =
    session.draftState === 'saved'
      ? 'savedDraft'
      : session.draftState === 'saving'
        ? 'savingDraft'
        : session.draftState === 'failed'
          ? 'draftFailure'
          : undefined;
  async function submit() {
    if (!onConfirm || submitting.current || busy) return;
    submitting.current = true;
    setPending(true);
    try {
      await onConfirm();
      if (onOpenChange) onOpenChange(false);
      else session.close();
    } catch {
      // 保存失败由内容自己的错误状态反馈，保留阅读和草稿会话。
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  useLayoutEffect(() => {
    if (foreground) ref.current?.focus({ preventScroll: true });
  }, [foreground]);
  return (
    <div
      ref={ref}
      role={foreground ? 'dialog' : mini ? 'region' : undefined}
      aria-labelledby={id}
      aria-describedby={description && foreground ? id + '-description' : undefined}
      tabIndex={-1}
      className={`flex h-full min-h-0 outline-none ${mini ? 'flex-row-reverse gap-2 overflow-hidden border-t border-border bg-surface-raised px-2' : 'flex-col bg-canvas'}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || blocked || mini) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <header
        className={`flex min-h-12 items-center gap-1 px-2 sm:gap-2 sm:px-4 ${mini ? 'min-w-0 flex-1' : 'shrink-0 border-b border-border bg-surface'}`}
      >
        {foreground ? (
          <IconAction label={t('files.viewer.back')} tooltip disabled={blocked} onPress={close}>
            <ArrowLeft />
          </IconAction>
        ) : null}
        <h2
          id={id}
          title={session.entry.name}
          className="min-w-0 flex-1 truncate text-sm font-semibold sm:text-base"
        >
          {session.entry.name}
        </h2>
        {description ? (
          <p id={id + '-description'} className="sr-only">
            {description}
          </p>
        ) : null}
        {foreground ? (
          <>
            {headerAction}
            {confirmLabel && onConfirm ? (
              <Action
                size="sm"
                disabled={Boolean(blocked || confirmDisabled)}
                loading={pending}
                onPress={() => void submit()}
              >
                {confirmLabel}
              </Action>
            ) : null}
            <IconAction label={t('files.download')} tooltip onPress={() => session.download()}>
              <Download />
            </IconAction>
            <MenuButton
              ariaLabel={t('files.viewer.actions')}
              label={<MoreHorizontal />}
              triggerVariant="icon"
              items={[{ id: 'folder', label: t('files.viewer.openFolder') }]}
              onAction={session.openFolder}
            />
          </>
        ) : null}
        <IconAction
          label={
            mini
              ? t('files.viewer.backToVideo')
              : t(session.video ? 'files.viewer.miniVideo' : 'files.viewer.minimize')
          }
          tooltip
          disabled={blocked}
          onPress={mini ? session.restore : session.minimize}
        >
          <span aria-hidden="true">{mini ? '↗' : '−'}</span>
        </IconAction>
        <IconAction label={cancelLabel} disabled={blocked} tooltip onPress={close}>
          <span aria-hidden="true">×</span>
        </IconAction>
      </header>
      {foreground && draftMessage ? (
        <p
          role="status"
          className="shrink-0 border-b border-border bg-surface px-3 py-1 text-xs text-ink-muted"
        >
          {t('files.viewer.' + draftMessage)}
        </p>
      ) : null}
      <div
        className={`min-h-0 overflow-auto ${mini ? 'file-reader-mini-viewport shrink-0' : 'flex-1 p-3 sm:p-4'}`}
      >
        {children}
      </div>
      {foreground && failureMessage ? (
        <p role="alert" className="px-3 text-sm text-danger">
          {failureMessage}
        </p>
      ) : null}
      {foreground && footerAction ? (
        <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border bg-surface px-3 py-2">
          {footerAction}
        </footer>
      ) : null}
    </div>
  );
}
