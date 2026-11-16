'use client';
import Button from '@mui/material/Button';
import type { ReactNode } from 'react';
type OverlayTriggerBehavior = Readonly<{
  type?: 'button';
  onPress?: () => void;
  disabled?: boolean;
}>;
export type OverlayTriggerActionProps = Readonly<{
  children: ReactNode;
  /** 语义 tone：default = 中性 trigger；danger = 危险语义 trigger。 */
  tone?: 'default' | 'danger';
  fullWidth?: boolean;
}> &
  OverlayTriggerBehavior;

export function OverlayTriggerAction({
  children,
  tone = 'default',
  fullWidth = false,
  disabled = false,
  type = 'button',
  onPress,
}: OverlayTriggerActionProps) {
  return (
    <Button
      className={`ui-overlay-trigger ${tone === 'danger' ? 'ui-overlay-trigger-danger text-danger border-danger/30 hover:bg-danger-soft' : ''}`}
      fullWidth={fullWidth}
      disabled={disabled}
      type={type}
      onClick={onPress}
      variant="outlined"
      color={tone === 'danger' ? 'error' : 'primary'}
    >
      {children}
    </Button>
  );
}
