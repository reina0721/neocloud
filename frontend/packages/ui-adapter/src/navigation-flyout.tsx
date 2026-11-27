import Popper from '@mui/material/Popper';
import Paper from '@mui/material/Paper';
import Fade from '@mui/material/Fade';
import { useTheme } from '@mui/material/styles';
import { designParameters } from '@neocloud/design-system/parameters';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import ButtonBase from '@mui/material/ButtonBase';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';

export { default as NavigationHint } from './navigation-hint';

const navigationFlyoutCloseDelayMs = designParameters.duration.fast;
// Compact Navigation 属于非模态子菜单；Pointer 打开时保持当前焦点，键盘打开时仍进入 Overlay。

export type NavigationFlyoutProps = Readonly<{
  label: string;
  icon: ReactNode;
  active?: boolean;
  isOpen: boolean;
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
}>;

export function NavigationFlyout({
  label,
  icon,
  active = false,
  isOpen,
  children,
  onOpenChange,
}: NavigationFlyoutProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const keyboardOpen = useRef(false);
  const attachContent = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    if (keyboardOpen.current) node?.querySelector<HTMLElement>('a,button,[tabindex="0"]')?.focus();
  }, []);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const openRef = useRef(isOpen);
  const ignoreNextPressCloseRef = useRef(false);
  const pointerOverTriggerRef = useRef(false);
  const pointerOverContentRef = useRef(false);
  const pinnedRef = useRef(false);
  const focusWithinContentRef = useRef(false);
  const theme = useTheme();
  // 渲染后同步的 isOpen 快照：延迟关闭回调在计时器触发时读取最新值，
  // 避免闭包捕获旧 isOpen 导致父级已关闭后仍向上冒泡误关新菜单。
  const isOpenRef = useRef(isOpen);

  useEffect(() => {
    openRef.current = isOpen;
    isOpenRef.current = isOpen;
    if (!isOpen) pinnedRef.current = false;
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && keyboardOpen.current)
      contentRef.current?.querySelector<HTMLElement>('a,button,[tabindex="0"]')?.focus();
  }, [isOpen]);

  const cancelScheduledClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
  };
  const requestOpenChange = (open: boolean) => {
    if (openRef.current === open) return;
    // 父级已通过 isOpen prop 关闭（兄弟切换或叶子导航）后，延迟关闭回调不能再向上冒泡，
    // 否则会把新打开的兄弟菜单误关。
    if (!open && !isOpenRef.current) return;
    openRef.current = open;
    onOpenChange(open);
  };
  const scheduleClose = () => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = undefined;
      if (
        !pointerOverTriggerRef.current &&
        !pointerOverContentRef.current &&
        !pinnedRef.current &&
        !focusWithinContentRef.current
      ) {
        requestOpenChange(false);
      }
    }, navigationFlyoutCloseDelayMs);
  };

  const handleOpenChange = (open: boolean) => {
    if (open) {
      cancelScheduledClose();
      if (!openRef.current) pinnedRef.current = true;
    }
    if (!open && ignoreNextPressCloseRef.current) {
      ignoreNextPressCloseRef.current = false;
      return;
    }
    // 父级切换兄弟菜单后，旧实例的延迟关闭不能影响新实例。
    if (!open && !isOpenRef.current) return;
    if (!open) pinnedRef.current = false;
    requestOpenChange(open);
  };

  const enterFromKeyboard = () => {
    keyboardOpen.current = true;
    pinnedRef.current = true;
    ignoreNextPressCloseRef.current = false;
    cancelScheduledClose();
    requestOpenChange(true);
    contentRef.current?.querySelector<HTMLElement>('a,button,[tabindex="0"]')?.focus();
  };

  useEffect(() => () => cancelScheduledClose(), []);

  return (
    <>
      <ButtonBase
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={isOpen}
        className="ui-navigation-icon-trigger"
        data-active={active || undefined}
        data-open={isOpen || undefined}
        data-navigation-control
        onClick={(event) => {
          if (event.detail === 0) enterFromKeyboard();
          else handleOpenChange(!isOpen);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            enterFromKeyboard();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            requestOpenChange(false);
          }
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'mouse') return;
          keyboardOpen.current = false;
          pointerOverTriggerRef.current = true;
          cancelScheduledClose();
          requestOpenChange(true);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== 'mouse') return;
          pointerOverTriggerRef.current = false;
          scheduleClose();
        }}
        onPointerDownCapture={(event) => {
          ignoreNextPressCloseRef.current =
            event.pointerType === 'mouse' && openRef.current && !pinnedRef.current;
          pinnedRef.current = true;
        }}
      >
        <span aria-hidden="true" className="ui-navigation-icon">
          {icon}
        </span>
        <span aria-hidden="true" className="absolute end-1 bottom-1 text-xs">
          ›
        </span>
      </ButtonBase>
      <Popper
        open={isOpen}
        anchorEl={() => triggerRef.current!}
        placement="right-start"
        modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}
        style={{ zIndex: 'var(--z-index-overlay)' }}
      >
        <ClickAwayListener
          onClickAway={(event) => {
            const target = event.target;
            if (target instanceof Element && target.closest('[data-navigation-control]')) return;
            handleOpenChange(false);
          }}
        >
          <Fade in={isOpen} timeout={theme.transitions.duration.standard}>
            <Paper
              ref={attachContent}
              role="dialog"
              aria-modal="false"
              aria-label={label}
              className="ui-overlay-surface ui-menu-surface w-72 p-2"
              data-navigation-flyout
              onPointerEnter={() => {
                pointerOverContentRef.current = true;
                cancelScheduledClose();
              }}
              onPointerLeave={() => {
                pointerOverContentRef.current = false;
                scheduleClose();
              }}
              onFocusCapture={() => {
                focusWithinContentRef.current = true;
                cancelScheduledClose();
              }}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  focusWithinContentRef.current = false;
                  scheduleClose();
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  handleOpenChange(false);
                  triggerRef.current?.focus();
                }
              }}
            >
              <p className="border-b border-border px-3 py-2 text-sm font-semibold text-ink">
                {label}
              </p>
              {children}
            </Paper>
          </Fade>
        </ClickAwayListener>
      </Popper>
    </>
  );
}
