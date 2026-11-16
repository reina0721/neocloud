'use client';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
const MobileNavigationSurface = lazy(() => import('./mobile-navigation-surface'));
export type MobileNavigationItem = Readonly<{
  id: string;
  label: string;
  icon: ReactNode;
  href?: string;
}>;

/** CSS 决定断点；仅在底部预留区可见时加载 Material 导航。 */
export function MobileNavigation(
  props: Readonly<{
    label: string;
    value?: string | undefined;
    items: readonly MobileNavigationItem[];
    onSelect: (id: string) => void;
  }>,
) {
  const [element, ref] = useState<HTMLDivElement | null>(null);
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (!element) return;
    const measure = () => setMobile(element.clientHeight > 0);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [element]);
  return (
    <>
      <Suspense
        fallback={
          <div
            className="ui-mobile-navigation flex items-center justify-around"
            role="status"
            aria-label={props.label}
          >
            {props.items.map((item) => (
              <span key={item.id} className="ui-skeleton size-control rounded-control" />
            ))}
          </div>
        }
      >
        {mobile ? <MobileNavigationSurface {...props} /> : null}
      </Suspense>
      <div ref={ref} className="ui-mobile-navigation-spacer" aria-hidden="true" />
    </>
  );
}
