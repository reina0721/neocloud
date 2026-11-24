'use client';

import { useCallback, useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { FileMediaDockProps } from '@clouddrive/surface/files/runtime';
import { IconAction } from '@clouddrive/ui-adapter/icon-action';
import { ChevronUp } from 'lucide-react';

function inVideoCard(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('[data-reader-media-card]'));
}

export function MusicDock({
  label,
  expandLabel,
  open,
  onOpen,
  onClose,
  backCard,
  children,
}: FileMediaDockProps) {
  const id = useId();
  const dock = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const mouseInside = useRef(false);
  const focusOnOpen = useRef(false);
  const drag = useRef<number | null>(null);
  const switchPoint = useRef<{ x: number; y: number } | null>(null);

  const collapse = useCallback(() => {
    onClose();
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>(`button[aria-controls="${id}"]`)
        ?.focus({ preventScroll: true }),
    );
  }, [id, onClose]);

  const closeAfterMouseLeaves = useCallback(() => {
    if (mouseInside.current || drag.current !== null) return;
    const active = document.activeElement;
    const focusedInPanel = active && (panel.current?.contains(active) || inVideoCard(active));
    if (focusedInPanel && active.matches(':focus-visible')) return;
    onClose();
    if (focusedInPanel) {
      requestAnimationFrame(() => handle.current?.focus({ preventScroll: true }));
    }
  }, [onClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const surface = panel.current;
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      const video = document.querySelector<HTMLElement>('[data-reader-media-card] [role="region"]');
      (video ?? surface)?.focus({ preventScroll: true });
    }
    function dismissFromKeyboard(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      collapse();
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
        !(target instanceof Element && target.closest('[data-file-dock-trigger]')) &&
        !inVideoCard(target)
      ) {
        onClose();
      }
    }
    function leaveVideo(event: PointerEvent) {
      const next = event.relatedTarget;
      if (
        event.pointerType !== 'mouse' ||
        !inVideoCard(event.target) ||
        inVideoCard(next) ||
        (next instanceof Node && dock.current?.contains(next))
      )
        return;
      mouseInside.current = false;
      closeAfterMouseLeaves();
    }
    function trackSwitch(event: PointerEvent) {
      const point = switchPoint.current;
      if (!point || (point.x === event.clientX && point.y === event.clientY)) return;
      switchPoint.current = null;
      mouseInside.current =
        (event.target instanceof Node && Boolean(dock.current?.contains(event.target))) ||
        inVideoCard(event.target);
      closeAfterMouseLeaves();
    }
    function closeVideoControls(event: KeyboardEvent) {
      if (inVideoCard(event.target)) dismissFromKeyboard(event);
    }
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('pointerout', leaveVideo);
    document.addEventListener('pointermove', trackSwitch);
    document.addEventListener('keydown', closeVideoControls);
    surface?.addEventListener('keydown', dismissFromKeyboard);
    return () => {
      drag.current = null;
      switchPoint.current = null;
      document.removeEventListener('pointerup', endDrag);
      document.removeEventListener('pointercancel', endDrag);
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('pointerout', leaveVideo);
      document.removeEventListener('pointermove', trackSwitch);
      document.removeEventListener('keydown', closeVideoControls);
      surface?.removeEventListener('keydown', dismissFromKeyboard);
    };
  }, [closeAfterMouseLeaves, collapse, onClose, open]);

  return createPortal(
    <div className="music-dock pointer-events-none fixed inset-x-0 z-toast flex justify-center px-2">
      <div
        ref={dock}
        data-music-dock
        className={`pointer-events-auto relative ${open ? 'w-full max-w-5xl' : ''}`}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'mouse') return;
          mouseInside.current = true;
          onOpen();
        }}
        onPointerLeave={(event) => {
          if (
            event.pointerType !== 'mouse' ||
            switchPoint.current ||
            inVideoCard(event.relatedTarget)
          )
            return;
          mouseInside.current = false;
          closeAfterMouseLeaves();
        }}
      >
        {open ? null : (
          <div className="rounded-t-panel border border-border bg-surface-raised shadow-panel">
            <IconAction
              ref={handle}
              label={expandLabel}
              expanded={false}
              controls={id}
              onPress={() => {
                focusOnOpen.current = true;
                onOpen();
              }}
            >
              <ChevronUp aria-hidden="true" className="size-icon-sm" />
            </IconAction>
          </div>
        )}
        <section
          hidden={!open}
          ref={panel}
          data-reader-media-panel
          id={id}
          tabIndex={-1}
          aria-label={label}
          className="music-dock-panel flex flex-col rounded-t-panel border border-border bg-surface-raised text-ink shadow-overlay"
          onBlur={(event) => {
            if (
              !mouseInside.current &&
              event.relatedTarget &&
              !event.currentTarget.contains(event.relatedTarget) &&
              !inVideoCard(event.relatedTarget)
            ) {
              onClose();
            }
          }}
          onPointerDownCapture={(event) => {
            if (event.pointerType !== 'mouse' || !(event.target instanceof Element)) return;
            if (event.target.closest('[data-music-slider]')) drag.current = event.pointerId;
            if (event.target.closest('[data-media-switch]'))
              switchPoint.current = { x: event.clientX, y: event.clientY };
          }}
        >
          {backCard ? (
            <div data-media-switch className="absolute bottom-full left-2">
              {backCard}
            </div>
          ) : null}
          {children(collapse)}
        </section>
      </div>
    </div>,
    document.body,
  );
}
