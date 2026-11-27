'use client';

import { useEffect, useState } from 'react';
import { useFrontendTranslation } from '@neocloud/i18n';
import { Action } from '@neocloud/ui-adapter/action';
import { DialogSurface } from '@neocloud/ui-adapter/overlays';
import { formatFileBytes } from '../../../src/files/format';
import { FilesError } from '../../../src/files/model';
import { useFiles } from '../../../src/files/runtime';
import type { TrashPurgePreview, TrashPurgeSelection } from '../../../src/files/trash-purge';

type Feedback =
  | { state: 'loading' }
  | { state: 'ready'; preview: TrashPurgePreview }
  | { state: 'failed'; message: string; canRetry: boolean };

export default function TrashPurgeDialog({
  selection,
  onClose,
  onPurged,
}: {
  selection: TrashPurgeSelection;
  onClose: () => void;
  onPurged: (receipt: TrashPurgePreview) => void;
}) {
  const files = useFiles();
  const { t } = useFrontendTranslation();
  const [feedback, setFeedback] = useState<Feedback>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const all = selection.scope === 'all';
  const title = t(all ? 'files.trashPurge.empty' : 'files.trashPurge.permanent');
  const budgetMessage = t(
    all ? 'files.trashPurge.allOverBudget' : 'files.trashPurge.selectionOverBudget',
  );
  useEffect(() => {
    const controller = new AbortController();
    void files.previewTrashPurge(selection, controller.signal).then(
      (preview) => {
        if (!controller.signal.aborted) setFeedback({ state: 'ready', preview });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const code = error instanceof FilesError ? error.code : 'unavailable';
        setFeedback({
          state: 'failed',
          message: code === 'large' ? budgetMessage : t('files.errors.' + code),
          canRetry: code !== 'large',
        });
      },
    );
    return () => controller.abort();
  }, [files, selection, attempt, budgetMessage, t]);

  async function confirm() {
    if (feedback.state !== 'ready' || feedback.preview.entryCount === 0) return;
    let receipt: TrashPurgePreview;
    try {
      receipt = await files.purgeTrash(selection, feedback.preview.snapshot);
    } catch (error) {
      const code = error instanceof FilesError ? error.code : 'unavailable';
      setFeedback({
        state: 'failed',
        message:
          code === 'large'
            ? budgetMessage
            : code === 'conflict' || code === 'missing'
              ? t('files.trashPurge.changed')
              : t('files.errors.' + code),
        canRetry: code !== 'large',
      });
      throw error;
    }
    onPurged(receipt);
  }

  return (
    <DialogSurface
      isOpen
      triggerLabel={title}
      title={title}
      description={t(all ? 'files.trashPurge.allHint' : 'files.trashPurge.selectionHint')}
      confirmLabel={title}
      cancelLabel={t('files.cancel')}
      confirmDisabled={feedback.state !== 'ready' || feedback.preview.entryCount === 0}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onConfirm={confirm}
    >
      {feedback.state === 'loading' ? <p role="status">{t('files.loading')}</p> : null}
      {feedback.state === 'failed' ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-danger">
            {feedback.message}
          </p>
          {feedback.canRetry ? (
            <Action
              size="sm"
              variant="secondary"
              onPress={() => {
                setFeedback({ state: 'loading' });
                setAttempt((value) => value + 1);
              }}
            >
              {t('files.trashPurge.recheck')}
            </Action>
          ) : null}
        </div>
      ) : null}
      {feedback.state === 'ready' ? (
        feedback.preview.entryCount === 0 ? (
          <p role="status">{t('files.emptyTrash')}</p>
        ) : (
          <div className="space-y-2">
            <p>
              {t('files.trashPurge.impact', {
                entries: feedback.preview.entryCount,
                roots: feedback.preview.rootCount,
                bytes: formatFileBytes(feedback.preview.bytes),
              })}
            </p>
            <p className="text-sm text-ink-muted">{t('files.trashPurge.storageHint')}</p>
          </div>
        )
      ) : null}
    </DialogSurface>
  );
}
