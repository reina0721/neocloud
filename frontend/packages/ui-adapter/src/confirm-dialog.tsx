'use client';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import { useId, useRef, useState, type ReactNode } from 'react';
import { Action } from './action';
import { OverlayTriggerAction } from './overlay-trigger';
export type ConfirmDialogProps = Readonly<{
  triggerLabel: string;
  title: string;
  description: string;
  impact: ReactNode;
  cancelLabel: string;
  confirmLabel: string;
  failureMessage: string;
  tone?: 'primary' | 'danger';
  defaultOpen?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void | Promise<void>;
  /**
   * 受控模式：提供 isOpen/onOpenChange 时隐藏 trigger，由父级控制开关
   * （Host leave-confirm 等命令式确认场景）。triggerLabel 仍须提供（无障碍命名）。
   */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}>;

export function ConfirmDialog({
  triggerLabel,
  title,
  description,
  impact,
  cancelLabel,
  confirmLabel,
  failureMessage,
  tone = 'primary',
  defaultOpen = false,
  confirmDisabled = false,
  onConfirm,
  isOpen,
  onOpenChange,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const controlled = isOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlled ? isOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (controlled) onOpenChange?.(next);
    else setInternalOpen(next);
  };
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [failed, setFailed] = useState(false);

  const confirm = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFailed(false);
    try {
      await onConfirm();
      setOpen(false);
    } catch {
      setFailed(true);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <>
      {controlled ? null : (
        <OverlayTriggerAction
          tone={tone === 'danger' ? 'danger' : 'default'}
          onPress={() => setOpen(true)}
        >
          {triggerLabel}
        </OverlayTriggerAction>
      )}
      <Dialog
        open={open}
        onClose={() => {
          if (!pendingRef.current) setOpen(false);
        }}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        fullWidth
        maxWidth="sm"
        role="alertdialog"
        slotProps={{ paper: { className: 'ui-overlay-surface ui-dialog-layout' } }}
      >
        <DialogTitle component="h2" id={titleId} className="px-6 pt-6 text-lg font-bold text-ink">
          {title}
        </DialogTitle>
        <DialogContent className="ui-dialog-body px-6 py-4 text-sm leading-6 text-ink-muted">
          <p id={descriptionId}>{description}</p>
          <div className="mt-3 rounded-control bg-surface-muted p-3 text-ink">{impact}</div>
          {failed ? (
            <p role="alert" className="mt-3 font-medium text-danger">
              {failureMessage}
            </p>
          ) : null}
        </DialogContent>
        <DialogActions className="ui-dialog-footer flex flex-wrap gap-3 border-t border-border px-6 py-4">
          <Action variant="quiet" disabled={pending} onPress={() => setOpen(false)}>
            {cancelLabel}
          </Action>
          <Action
            variant={tone === 'danger' ? 'danger' : 'primary'}
            disabled={confirmDisabled || pending}
            loading={pending}
            onPress={() => void confirm()}
          >
            {confirmLabel}
          </Action>
        </DialogActions>
      </Dialog>
    </>
  );
}
export type DestructiveConfirmDialogProps = Omit<ConfirmDialogProps, 'tone'>;

export function DestructiveConfirmDialog(props: DestructiveConfirmDialogProps) {
  return <ConfirmDialog {...props} tone="danger" />;
}
