'use client';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import { useId, useRef, useState, type ReactNode } from 'react';
import { Action } from './action';
import { IconAction } from './icon-action';
import { OverlayTriggerAction } from './overlay-trigger';
export type DialogSurfaceProps = Readonly<{
  triggerLabel: string;
  title: string;
  description: string;
  children: ReactNode;
  cancelLabel: string;
  /** 压缩包等连续浏览工作区使用cover，普通确认保持lg。 */
  size?: 'lg' | 'cover' | 'fullscreen';
  headerAction?: ReactNode;
  keepMounted?: boolean;
  /** workspace 为连续阅读保留视口，使用紧凑边距；普通确认保持standard。 */
  layout?: 'standard' | 'workspace';
  /**
   * 可选确认动作：缺省时 Dialog 只保留关闭动作（设置面板等不需要二次确认的
   * 普通决策场景），不再强行渲染"确认"语义。
   */
  confirmLabel?: string;
  defaultOpen?: boolean;
  confirmDisabled?: boolean;
  failureMessage?: string;
  /** 表单提交或结果操作置于固定 Footer，仍由宿主拥有其业务状态。 */
  footerAction?: ReactNode;
  /** 外部异步操作进行中时保留当前窗口，避免失去结果。 */
  busy?: boolean;
  onConfirm?: () => void | Promise<void>;
  /**
   * 受控模式：提供 isOpen 时隐藏 trigger，由父级控制开关
   * （工具栏驱动的列设置等命令式面板）。triggerLabel 仍须提供（无障碍命名）。
   */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}>;

export function DialogSurface({
  triggerLabel,
  title,
  description,
  children,
  cancelLabel,
  size = 'lg',
  layout = 'standard',
  confirmLabel,
  defaultOpen = false,
  confirmDisabled = false,
  failureMessage,
  footerAction,
  busy = false,
  onConfirm,
  isOpen,
  onOpenChange,
  headerAction,
  keepMounted = false,
}: DialogSurfaceProps) {
  const titleId = useId();
  const descriptionId = useId();
  const controlled = isOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlled ? isOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (controlled) onOpenChange?.(next);
    else setInternalOpen(next);
  };
  const [confirming, setConfirming] = useState(false);
  const pending = busy || confirming;
  const pendingRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const showConfirm = Boolean(onConfirm) && Boolean(confirmLabel);
  const headerClose = layout === 'workspace' && !showConfirm && !footerAction;

  const confirm = async () => {
    if (!onConfirm || busy || pendingRef.current) return;
    pendingRef.current = true;
    setConfirming(true);
    setFailed(false);
    try {
      await onConfirm();
      setOpen(false);
    } catch {
      setFailed(true);
    } finally {
      pendingRef.current = false;
      setConfirming(false);
    }
  };

  return (
    <>
      {controlled ? null : (
        <OverlayTriggerAction onPress={() => setOpen(true)}>{triggerLabel}</OverlayTriggerAction>
      )}
      <Dialog
        open={open}
        keepMounted={keepMounted}
        onClose={() => {
          if (!pending) setOpen(false);
        }}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        fullWidth
        fullScreen={size === 'fullscreen'}
        maxWidth={size === 'lg' ? 'md' : false}
        slotProps={{
          paper: {
            className: `ui-overlay-surface ui-dialog-layout ${layout === 'workspace' ? 'ui-dialog-workspace' : ''} ${size === 'fullscreen' ? 'ui-dialog-fullscreen' : ''}`,
            sx:
              size === 'cover'
                ? {
                    margin: '1rem',
                    width: 'calc(100dvw - 2rem)',
                    height: layout === 'workspace' ? 'calc(100dvh - 2rem)' : undefined,
                    maxWidth: 'none',
                  }
                : undefined,
          },
        }}
      >
        <DialogTitle
          id={titleId + '-container'}
          component="div"
          className={`shrink-0 border-b border-border ${size === 'fullscreen' ? 'px-4 py-1' : layout === 'workspace' ? 'px-4 py-3' : 'px-6 py-5'}`}
        >
          <div
            className={`flex ${size === 'fullscreen' ? 'items-center' : 'items-start'} justify-between gap-3`}
          >
            <div className="min-w-0">
              <h2
                id={titleId}
                className={`${layout === 'workspace' ? 'truncate text-base' : 'text-lg'} font-semibold text-ink`}
              >
                {title}
              </h2>
              {description ? (
                <p
                  id={descriptionId}
                  className={`${layout === 'workspace' ? 'hidden md:block' : ''} mt-1 text-sm leading-6 text-ink-muted`}
                >
                  {description}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {headerAction}
              {headerClose ? (
                <IconAction
                  size={size === 'fullscreen' ? 'lg' : 'md'}
                  label={cancelLabel}
                  disabled={pending}
                  onPress={() => setOpen(false)}
                >
                  <span aria-hidden="true">×</span>
                </IconAction>
              ) : null}
            </div>
          </div>
        </DialogTitle>
        <DialogContent className="ui-dialog-body">{children}</DialogContent>
        {failed && failureMessage ? (
          <p className="px-6 pb-4 text-sm font-medium text-danger" role="alert">
            {failureMessage}
          </p>
        ) : null}
        {!headerClose ? (
          <DialogActions className="ui-dialog-footer flex shrink-0 flex-wrap gap-3 border-t border-border px-6 py-4">
            <Action variant="quiet" disabled={pending} onPress={() => setOpen(false)}>
              {cancelLabel}
            </Action>
            {showConfirm ? (
              <Action
                disabled={confirmDisabled || pending}
                loading={pending}
                onPress={() => void confirm()}
              >
                {confirmLabel}
              </Action>
            ) : null}
            {footerAction}
          </DialogActions>
        ) : null}
      </Dialog>
    </>
  );
}
