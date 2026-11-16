import { useControlLocale } from './control-locale-context';

// MUI 的附属按钮与空结果消息遵循应用语言，业务结果标题仍由消费方提供。
const messages = {
  'zh-CN': {
    clearText: '清除',
    closeText: '收起',
    openText: '展开',
    loadingText: '正在加载…',
    noOptionsText: '没有匹配项',
  },
  en: {
    clearText: 'Clear',
    closeText: 'Close',
    openText: 'Open',
    loadingText: 'Loading…',
    noOptionsText: 'No options',
  },
} as const;
export function useAutocompleteMessages() {
  const { locale } = useControlLocale();
  return messages[locale.startsWith('zh') ? 'zh-CN' : 'en'];
}
