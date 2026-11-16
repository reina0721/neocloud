import { useId, useState } from 'react';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { enUS, zhCN } from '@mui/x-date-pickers/locales';
import dayjs from 'dayjs';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import localeData from 'dayjs/plugin/localeData';
import en from 'dayjs/locale/en';
import zh from 'dayjs/locale/zh-cn';
import { useControlLocale } from './control-locale-context';
import type { DatePickerFieldProps } from './date-picker-field';

// 先初始化官方格式插件，再复制 locale；英文 locale 的 formats 由该插件补齐。
dayjs.extend(localizedFormat);
dayjs.extend(localeData);
const englishLocaleData = dayjs().locale('en').localeData();
const englishFormats = Object.fromEntries(
  (['LTS', 'LT', 'L', 'LL', 'LLL', 'LLLL'] as const).map((format) => [
    format,
    englishLocaleData.longDateFormat(format),
  ]),
);
// 注册不可变 locale，不切换进程级当前语言。
for (const [language, source] of [
  ['en', { ...en, formats: englishFormats }],
  ['zh', zh],
] as const)
  for (const [start, weekStart] of [
    ['monday', 1],
    ['sunday', 0],
  ] as const)
    dayjs.locale(
      { ...source, name: `clouddrive-${language}-${start}`, weekStart },
      undefined,
      true,
    );

export default function DatePickerCalendar({
  label,
  hint,
  calendarLabel,
  disabled = false,
  defaultOpen = false,
  value,
  onValueChange,
}: DatePickerFieldProps) {
  const { locale, weekStart } = useControlLocale();
  const chinese = locale.startsWith('zh');
  const adapterLocale = `clouddrive-${chinese ? 'zh' : 'en'}-${weekStart ?? (chinese ? 'monday' : 'sunday')}`;
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <LocalizationProvider
      dateAdapter={AdapterDayjs}
      adapterLocale={adapterLocale}
      localeText={Object.fromEntries(
        Object.entries(
          (chinese ? zhCN : enUS).components.MuiLocalizationProvider.defaultProps.localeText,
        ).filter(([, value]) => value !== undefined),
      )}
    >
      <div className="ui-field">
        <label id={id + '-label'} htmlFor={id} className="ui-field-label">
          {label}
        </label>
        <DatePicker
          disabled={disabled}
          open={open}
          onOpen={() => setOpen(true)}
          onClose={() => setOpen(false)}
          {...(value === undefined ? {} : { value: value ? dayjs(value) : null })}
          onChange={(date) => {
            if (date === null) onValueChange?.(null);
            else if (date.isValid()) onValueChange?.(date.format('YYYY-MM-DD'));
          }}
          slotProps={{
            textField: {
              id,
              fullWidth: true,
              helperText: hint,
              slotProps: {
                input: { 'aria-labelledby': id + '-label' },
                htmlInput: { 'aria-label': label },
              },
            },
            openPickerButton: { 'aria-label': calendarLabel },
            desktopPaper: { className: 'ui-overlay-surface', 'aria-label': calendarLabel },
            mobilePaper: { className: 'ui-overlay-surface', 'aria-label': calendarLabel },
          }}
        />
      </div>
    </LocalizationProvider>
  );
}
