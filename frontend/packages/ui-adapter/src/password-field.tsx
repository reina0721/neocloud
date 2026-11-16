'use client';
import { useId, useState, type ReactNode } from 'react';
import MuiTextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import type { TextFieldProps } from './text-field';
export type PasswordFieldProps = Omit<TextFieldProps, 'purpose' | 'autoComplete'> &
  Readonly<{
    /** transient用于压缩包等临时密钥，不声明账号密码自动填充语义。 */
    purpose: 'current' | 'new' | 'transient';
    showLabel: string;
    hideLabel: string;
    visibilityIcons?: Readonly<{ show: ReactNode; hide: ReactNode }>;
  }>;

export function PasswordField({
  label,
  hint,
  error,
  disabled = false,
  name,
  value,
  defaultValue,
  purpose,
  showLabel,
  hideLabel,
  visibilityIcons,
  ref,
  onChange,
  onBlur,
  presentation = 'label',
  ...inputProps
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
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
        fullWidth
        disabled={disabled}
        error={Boolean(error)}
        name={name}
        value={value}
        defaultValue={defaultValue}
        type={visible ? 'text' : 'password'}
        autoComplete={
          purpose === 'transient' ? 'off' : purpose === 'new' ? 'new-password' : 'current-password'
        }
        inputRef={ref}
        onChange={onChange}
        onBlur={onBlur}
        helperText={error || hint}
        slotProps={{
          htmlInput: { ...inputProps, 'aria-label': label },
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  size="small"
                  disabled={disabled}
                  aria-label={visible ? hideLabel : showLabel}
                  aria-pressed={visible}
                  onClick={() => setVisible(!visible)}
                >
                  {visibilityIcons ? (
                    visible ? (
                      visibilityIcons.hide
                    ) : (
                      visibilityIcons.show
                    )
                  ) : (
                    <span className="text-xs">{visible ? hideLabel : showLabel}</span>
                  )}
                </IconButton>
              </InputAdornment>
            ),
          },
          formHelperText: { className: error ? 'ui-field-error' : 'ui-field-hint' },
        }}
      />
    </div>
  );
}
