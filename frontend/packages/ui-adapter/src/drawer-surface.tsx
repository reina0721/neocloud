'use client';
import Drawer from '@mui/material/Drawer';
import { useId, useState, useRef, useLayoutEffect, type ReactNode } from 'react';
import { OverlayTriggerAction } from './overlay-trigger';
import { IconAction } from './icon-action';
export type DrawerSurfaceProps = Readonly<{
  triggerLabel: string;
  title: string;
  description: string;
  children: ReactNode;
  /** 固定操作区位于滚动内容之外，可通过 form 关联正文中的表单。 */
  footer?: ReactNode;
  busy?: boolean;
  closeLabel: string;
  defaultOpen?: boolean;
  placement?: 'left' | 'right';
  composition?: 'standard' | 'navigation';
  /** 受控模式：提供 isOpen/onOpenChange 时隐藏 trigger，由父级控制开关。 */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}>;

export function DrawerSurface({
  triggerLabel,
  title,
  description,
  children,
  footer,
  busy = false,
  closeLabel,
  defaultOpen = false,
  isOpen,
  onOpenChange,
  placement = 'right',
  composition = 'standard',
}: DrawerSurfaceProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const controlled = isOpen !== undefined;
  const open = controlled ? isOpen : internalOpen;
  const id = useId();
  const paper = useRef<HTMLDivElement>(null);
  // 动作移除当前焦点节点时，在同一次提交中恢复到抽屉，确保紧接着的 Escape 可达。
  useLayoutEffect(() => {
    const surface = paper.current;
    if (open && surface?.ownerDocument.activeElement === surface?.ownerDocument.body)
      surface?.focus();
  });
  const setOpen = (next: boolean) => {
    if (busy && !next) return;
    if (controlled) onOpenChange?.(next);
    else setInternalOpen(next);
  };
  return (
    <>
      {controlled ? null : (
        <OverlayTriggerAction onPress={() => setOpen(true)}>{triggerLabel}</OverlayTriggerAction>
      )}
      <Drawer
        open={open}
        anchor={placement}
        onClose={() => setOpen(false)}
        slotProps={{
          paper: {
            ref: paper,
            tabIndex: -1,
            role: 'dialog',
            'aria-modal': true,
            'aria-labelledby': id,
            'aria-describedby': id + '-description',
            className: `ui-overlay-surface ${composition === 'navigation' ? 'ui-drawer-navigation' : 'ui-drawer-form'} flex h-full flex-col`,
            sx: {
              width: composition === 'navigation' ? 'min(24rem, 90dvw)' : 'min(32rem, 95dvw)',
              borderRadius: 0,
            },
          },
        }}
      >
        <header className="relative shrink-0 px-6 py-5 pr-20">
          <h2 id={id} className="line-clamp-2 break-words text-lg font-bold text-ink">
            {title}
          </h2>
          <p id={id + '-description'} className="mt-1 text-sm leading-6 text-ink-muted">
            {description}
          </p>
          <div className="absolute right-4 top-4">
            <IconAction label={closeLabel} disabled={busy} onPress={() => setOpen(false)}>
              <span aria-hidden="true">×</span>
            </IconAction>
          </div>
        </header>
        <div
          className={
            composition === 'navigation'
              ? 'min-h-0 flex-1 overflow-hidden'
              : 'min-h-0 flex-1 overflow-y-auto px-6 py-5'
          }
        >
          {children}
        </div>
        {footer ? (
          <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border px-6 py-4">
            {footer}
          </footer>
        ) : null}
      </Drawer>
    </>
  );
}
