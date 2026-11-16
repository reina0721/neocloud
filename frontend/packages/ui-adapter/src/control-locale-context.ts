import { createContext, useContext } from 'react';

export type ControlWeekStart = 'monday' | 'sunday';
export const ControlWeekStartContext = createContext<ControlWeekStart | undefined>(undefined);

export function useControlWeekStart() {
  return useContext(ControlWeekStartContext);
}

export const ControlLocaleContext = createContext<
  Readonly<{ locale: string; weekStart?: ControlWeekStart }>
>({ locale: 'zh-CN' });
export function useControlLocale() {
  return useContext(ControlLocaleContext);
}
