'use client';

import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { IconAction } from '@clouddrive/ui-adapter/icon-action';
import { ChevronUp } from 'lucide-react';

type MusicDockProps = Readonly<{
  id: string;
  label: string;
  expandLabel: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  toolbarTrigger: RefObject<HTMLButtonElement | null>;
  handle: RefObject<HTMLButtonElement | null>;
  panel: RefObject<HTMLElement | null>;
  children: ReactNode;
}>;

export function MusicDock({
  id,
  label,
  expandLabel,
  open,
  onOpen,
  onClose,
  toolbarTrigger,
  handle,
  panel,
  children,
}: MusicDockProps) {
  const dock = useRef<HTMLDivElement>(null);
  const mouseInside = useRef(false);
  const drag = useRef<number | null>(null);

  const closeAfterMouseLeaves = useCallback(() => {
    if (mouseInside.current || drag.current !== null) return;
    const active = document.activeElement;
    const focusedInPanel = active && panel.current?.contains(active);
    if (focusedInPanel && active.matches(':focus-visible')) return;
    onClose();
    if (focusedInPanel) {
      requestAnimationFrame(() => handle.current?.focus({ preventScroll: true }));
    }
  }, [handle, onClose, panel]);

  useEffect(() => {
    if (!open) return;
    const surface = panel.current;
    function dismissFromKeyboard(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
      requestAnimationFrame(() => handle.current?.focus({ preventScroll: true }));
    }
    function endDrag(event: PointerEvent) {
      if (event.pointerId !== drag.current) return;
      drag.current = null;
      closeAfterMouseLeaves();
    }
    function dismiss(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Node &&
        !dock.current?.contains(target) &&
        !toolbarTrigger.current?.contains(target)
      ) {
        onClose();
      }
    }
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    document.addEventListener('pointerdown', dismiss, true);
    surface?.addEventListener('keydown', dismissFromKeyboard);
    return () => {
      drag.current = null;
      document.removeEventListener('pointerup', endDrag);
      document.removeEventListener('pointercancel', endDrag);
      document.removeEventListener('pointerdown', dismiss, true);
      surface?.removeEventListener('keydown', dismissFromKeyboard);
    };
  }, [closeAfterMouseLeaves, handle, onClose, open, panel, toolbarTrigger]);

  return createPortal(
    <div className="music-dock pointer-events-none fixed inset-x-0 z-sticky flex justify-center px-2">
      <div
        ref={dock}
        data-music-dock
        className={`pointer-events-auto ${open ? 'w-full max-w-5xl' : ''}`}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'mouse') return;
          mouseInside.current = true;
          onOpen();
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== 'mouse') return;
          mouseInside.current = false;
          closeAfterMouseLeaves();
        }}
      >
        {open ? (
          <section
            ref={panel}
            id={id}
            tabIndex={-1}
            aria-label={label}
            className="music-dock-panel flex flex-col rounded-t-panel border border-border bg-surface-raised text-ink shadow-overlay"
            onBlur={(event) => {
              if (
                !mouseInside.current &&
                event.relatedTarget &&
                !event.currentTarget.contains(event.relatedTarget)
              ) {
                onClose();
              }
            }}
            onPointerDownCapture={(event) => {
              if (
                event.pointerType === 'mouse' &&
                event.target instanceof Element &&
                event.target.closest('[data-music-slider]')
              ) {
                drag.current = event.pointerId;
              }
            }}
          >
            {children}
          </section>
        ) : (
          <div className="rounded-t-panel border border-border bg-surface-raised shadow-panel">
            <IconAction
              ref={handle}
              label={expandLabel}
              expanded={false}
              onPress={() => {
                onOpen();
                requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
              }}
            >
              <ChevronUp aria-hidden="true" className="size-icon-sm" />
            </IconAction>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
