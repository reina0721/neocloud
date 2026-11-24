'use client';
import MuiTextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import type { Ref } from 'react';
import { zhCN, enUS } from '@mui/material/locale';
import { useControlLocale } from './control-locale-context';
export type SearchBoxProps = Readonly<{
  label: string;
  placeholder: string;
  value?: string;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onValueChange?: (value: string) => void;
}>;

export function SearchBox({
  label,
  placeholder,
  value,
  disabled = false,
  inputRef,
  onValueChange,
}: SearchBoxProps) {
  const { locale } = useControlLocale();
  const clearLabel =
    (locale.startsWith('zh') ? zhCN : enUS).components?.MuiAutocomplete?.defaultProps?.clearText ??
    'Clear';
  return (
    <MuiTextField
      type="search"
      variant="filled"
      hiddenLabel
      size="small"
      className="ui-search-field min-w-0 w-full"
      fullWidth
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      inputRef={inputRef}
      onChange={(event) => onValueChange?.(event.target.value)}
      slotProps={{
        htmlInput: { 'aria-label': label },
        input: {
          disableUnderline: true,
          startAdornment: (
            <InputAdornment position="start" sx={{ mt: 0 }}>
              <svg
                aria-hidden="true"
                className="size-4 text-ink-muted"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="10" cy="10" r="6" />
                <path d="m15 15 5 5" />
              </svg>
            </InputAdornment>
          ),
          endAdornment: value ? (
            <InputAdornment position="end">
              <IconButton aria-label={clearLabel} size="small" onClick={() => onValueChange?.('')}>
                <span aria-hidden="true">×</span>
              </IconButton>
            </InputAdornment>
          ) : null,
        },
      }}
    />
  );
}
