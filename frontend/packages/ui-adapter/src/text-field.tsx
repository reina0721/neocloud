'use client';
import MuiTextField from '@mui/material/TextField';
import { useId, type ChangeEvent, type FocusEvent, type Ref } from 'react';
import type { FieldTextProps, FieldValueProps } from './field-contract';
export type TextFieldProps = FieldTextProps &
  FieldValueProps &
  Readonly<{
    name?: string;
    presentation?: 'label' | 'control-only';
    ref?: Ref<HTMLInputElement>;
    placeholder?: string;
    maxLength?: number;
    disabled?: boolean;
    purpose?: 'text' | 'email';
    inputMode?: 'numeric' | 'decimal';
    autoComplete?: 'name' | 'email' | 'username' | 'off';
    onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
    onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
  }>;

export function TextField({
  label,
  hint,
  error,
  disabled = false,
  name,
  value,
  defaultValue,
  purpose = 'text',
  presentation = 'label',
  ref,
  onChange,
  onBlur,
  ...inputProps
}: TextFieldProps) {
  const id = useId();
  return (
    <div className="ui-field">
      {presentation === 'label' ? (
        <label className="ui-field-label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <MuiTextField
        id={id}
        className="ui-material-field"
        variant="outlined"
        fullWidth
        disabled={disabled}
        error={Boolean(error)}
        name={name}
        value={value}
        defaultValue={defaultValue}
        type={purpose}
        inputRef={ref}
        onChange={onChange}
        onBlur={onBlur}
        helperText={error || hint}
        slotProps={{
          htmlInput: { ...inputProps, 'aria-label': label },
          formHelperText: { className: error ? 'ui-field-error' : 'ui-field-hint' },
        }}
      />
    </div>
  );
}
