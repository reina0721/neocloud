'use client';
import Tooltip from '@mui/material/Tooltip';
import Button from '@mui/material/Button';
import { useState } from 'react';
export type TooltipActionProps = Readonly<{
  label: string;
  tooltip: string;
  defaultOpen?: boolean;
}>;

export function TooltipAction({ label, tooltip, defaultOpen = false }: TooltipActionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Tooltip
      title={tooltip}
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      enterDelay={100}
      arrow
    >
      <Button className="ui-overlay-trigger" variant="outlined">
        {label}
      </Button>
    </Tooltip>
  );
}
