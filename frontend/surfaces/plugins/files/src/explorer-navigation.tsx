'use client';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { DrawerSurface } from '@clouddrive/ui-adapter/overlays';
import { useEffect, useRef, type ReactNode } from 'react';

export function ExplorerNavigation({
  children,
  collapsed = false,
  onFocusFiles,
  open,
  onOpenChange: setOpen,
}: {
  children: (onNavigate: () => void, mobile: boolean) => ReactNode;
  collapsed?: boolean;
  onFocusFiles: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useFrontendTranslation();
  const wasOpen = useRef(false);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed) return;
    // 等待抽屉清除背景隔离和恢复焦点，再把焦点交给文件区域。
    const frame = requestAnimationFrame(onFocusFiles);
    return () => cancelAnimationFrame(frame);
  }, [open, onFocusFiles]);
  return (
    <>
      <aside
        className={
          'surface-file-sidebar hidden h-full min-h-0 py-4 md:block md:shrink-0 ' +
          (collapsed ? 'px-2 md:w-20' : 'px-3 md:w-64')
        }
      >
        {children(() => {}, false)}
      </aside>
      {open ? (
        <DrawerSurface
          placement="left"
          composition="navigation"
          triggerLabel={t('files.explorer.navigation')}
          title={t('files.explorer.navigation')}
          description={t('files.explorer.navigationHint')}
          closeLabel={t('files.close')}
          isOpen
          onOpenChange={setOpen}
        >
          <div className="flex h-full flex-col px-3 py-2">
            {children(() => setOpen(false), true)}
          </div>
        </DrawerSurface>
      ) : null}
    </>
  );
}
