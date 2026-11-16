'use client';
import Button from '@mui/material/Button';
import { useRef, type ReactNode } from 'react';
import { actionStyles } from './action-styles';
/** FileChoiceAction 通过同一按钮样式打开单文件选择，结果仅交给调用方。 */
export function FileChoiceAction({
  children,
  acceptedTypes,
  disabled = false,
  onSelect,
}: Readonly<{
  children: ReactNode;
  acceptedTypes: readonly string[];
  disabled?: boolean;
  onSelect: (file: File) => void;
}>) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        type="button"
        variant="outlined"
        className={actionStyles({ size: 'sm', variant: 'secondary' })}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {children}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        accept={acceptedTypes.join(',')}
        disabled={disabled}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) onSelect(file);
        }}
      />
    </>
  );
}
