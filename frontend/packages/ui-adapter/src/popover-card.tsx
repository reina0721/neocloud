'use client';
import Modal from '@mui/material/Modal';
import Popper from '@mui/material/Popper';
import Paper from '@mui/material/Paper';
import Backdrop from '@mui/material/Backdrop';
import Fade from '@mui/material/Fade';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import { IconAction } from './icon-action';
import { useTheme } from '@mui/material/styles';
import { useId, useState, useLayoutEffect, type RefObject, type ReactNode } from 'react';
export type PopoverCardProps = Readonly<{
  triggerLabel: string;
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  headerAction?: ReactNode;
  triggerIcon?: ReactNode;
  closeLabel?: string;
  size?: 'content' | 'comfortable';
  placement?: 'bottom-start' | 'top-start';
}>;

/** Modal 管理焦点与关闭，Popper 提供翻转和视口碰撞处理。 */
export function PopoverCard({
  triggerLabel,
  title,
  children,
  defaultOpen = false,
  isOpen,
  onOpenChange,
  triggerRef,
  headerAction,
  triggerIcon,
  closeLabel,
  size = 'content',
  placement = 'bottom-start',
}: PopoverCardProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = isOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (isOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  useLayoutEffect(() => {
    if (triggerRef) setAnchor(triggerRef.current);
  }, [triggerRef, open]);
  const target = anchor;
  const id = useId();
  const theme = useTheme();
  return (
    <>
      {triggerRef ? null : triggerIcon ? (
        <IconButton
          ref={setAnchor}
          className="ui-overlay-trigger size-control min-w-control"
          aria-label={triggerLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {triggerIcon}
        </IconButton>
      ) : (
        <Button
          ref={setAnchor}
          className="ui-overlay-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          variant="outlined"
        >
          {triggerLabel}
        </Button>
      )}
      <Modal
        open={Boolean(open && target)}
        onClose={() => setOpen(false)}
        slots={{ backdrop: Backdrop }}
        slotProps={{ backdrop: { invisible: true } }}
      >
        <Popper
          open={Boolean(open && target)}
          anchorEl={target}
          disablePortal
          placement={placement}
          modifiers={[
            { name: 'offset', options: { offset: [0, 8] } },
            { name: 'preventOverflow', options: { padding: 16 } },
            { name: 'flip', options: { padding: 16 } },
          ]}
          role="dialog"
          aria-modal="true"
          aria-labelledby={id}
          tabIndex={-1}
          sx={{ outline: 'none', maxWidth: 'calc(100dvw - 2rem)' }}
        >
          <Fade in={open} timeout={theme.transitions.duration.standard}>
            <Paper
              className="ui-overlay-surface max-w-sm overflow-y-auto p-4"
              sx={{
                maxHeight: 'calc(100dvh - 2rem)',
                ...(size === 'comfortable' ? { width: 'min(22rem, calc(100dvw - 2rem))' } : {}),
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 id={id} className="text-sm font-bold text-ink">
                  {title}
                </h2>
                <div className="flex shrink-0 items-center gap-1">
                  {headerAction}
                  {closeLabel ? (
                    <IconAction
                      size={triggerRef ? 'lg' : 'md'}
                      label={closeLabel}
                      onPress={() => setOpen(false)}
                    >
                      <span aria-hidden="true">×</span>
                    </IconAction>
                  ) : null}
                </div>
              </div>
              <div className="mt-2 text-sm leading-6 text-ink-muted">{children}</div>
            </Paper>
          </Fade>
        </Popper>
      </Modal>
    </>
  );
}
