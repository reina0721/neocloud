import { useEffect, useState } from 'react';

/** Browser adapter for content that changes composition at a named container breakpoint. */
export function useContainerBreakpoint(breakpoint: '4xl' | '7xl') {
  const [element, ref] = useState<HTMLDivElement | null>(null);
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const value = style.getPropertyValue(`--container-${breakpoint}`).trim();
      const rootSize = Number.parseFloat(
        getComputedStyle(element.ownerDocument.documentElement).fontSize,
      );
      const threshold = Number.parseFloat(value) * (value.endsWith('rem') ? rootSize : 1);
      setMatches(Number.isFinite(threshold) && element.clientWidth >= threshold);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [element, breakpoint]);
  return { ref, matches };
}
