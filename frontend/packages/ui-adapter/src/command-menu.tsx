'use client';
import { lazy, Suspense, useState } from 'react';
import { OverlayTriggerAction } from './overlay-trigger';
const CommandMenuSurface = lazy(() => import('./command-menu-surface'));
export type CommandItem = Readonly<{
  id: string;
  label: string;
  description: string;
  keywords?: readonly string[];
}>;

export type CommandMenuProps = Readonly<{
  triggerLabel: string;
  title: string;
  searchLabel: string;
  searchPlaceholder: string;
  emptyLabel: string;
  items: readonly CommandItem[];
  defaultOpen?: boolean;
  hideTrigger?: boolean;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onAction: (id: string) => void;
}>;

/** 命令集合按首次打开加载，触发器与受控状态始终保持原有 owner。 */
export function CommandMenu({
  defaultOpen = false,
  hideTrigger = false,
  isOpen,
  onOpenChange,
  ...props
}: CommandMenuProps) {
  const [internal, setInternal] = useState(defaultOpen);
  const controlled = isOpen !== undefined;
  const open = controlled ? isOpen : internal;
  const [activated, setActivated] = useState(open);
  if (open && !activated) setActivated(true);
  const setOpen = (next: boolean) => {
    if (controlled) onOpenChange?.(next);
    else setInternal(next);
  };
  return (
    <>
      {hideTrigger ? null : (
        <OverlayTriggerAction onPress={() => setOpen(true)}>
          {props.triggerLabel}
        </OverlayTriggerAction>
      )}
      <Suspense
        fallback={
          <span role="status" className="sr-only">
            {props.title}
          </span>
        }
      >
        {activated ? <CommandMenuSurface {...props} isOpen={open} onOpenChange={setOpen} /> : null}
      </Suspense>
    </>
  );
}
