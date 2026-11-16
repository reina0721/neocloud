'use client';
import MuiTextField from '@mui/material/TextField';
import { useId, type ChangeEvent, type FocusEvent, type KeyboardEvent, type Ref } from 'react';
import type { FieldTextProps, FieldValueProps } from './field-contract';
export type TextAreaFieldProps = FieldTextProps &
  FieldValueProps &
  Readonly<{
    name?: string;
    ref?: Ref<HTMLTextAreaElement>;
    placeholder?: string;
    disabled?: boolean;
    rows?: number;
    content?: 'text' | 'code';
    onChange?: (event: ChangeEvent<HTMLTextAreaElement>) => void;
    onBlur?: (event: FocusEvent<HTMLTextAreaElement>) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  }>;

export function TextAreaField({
  label,
  hint,
  error,
  disabled = false,
  rows = 4,
  content = 'text',
  name,
  value,
  defaultValue,
  ref,
  onChange,
  onBlur,
  onKeyDown,
  ...inputProps
}: TextAreaFieldProps) {
  const id = useId();
  return (
    <div className="ui-field">
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      <MuiTextField
        id={id}
        className={`ui-material-field ${content === 'code' ? 'ui-code-field' : ''}`}
        multiline
        rows={rows}
        fullWidth
        disabled={disabled}
        error={Boolean(error)}
        name={name}
        value={value}
        defaultValue={defaultValue}
        inputRef={ref}
        onChange={onChange}
        onBlur={onBlur}
        helperText={error || hint}
        slotProps={{
          htmlInput: {
            ...inputProps,
            onKeyDown,
            spellCheck: content === 'code' ? false : undefined,
            autoCapitalize: content === 'code' ? 'none' : undefined,
            autoCorrect: content === 'code' ? 'off' : undefined,
            'aria-label': label,
          },
          formHelperText: { className: error ? 'ui-field-error' : 'ui-field-hint' },
        }}
      />
    </div>
  );
}
