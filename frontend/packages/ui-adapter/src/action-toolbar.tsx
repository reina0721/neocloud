import Toolbar from '@mui/material/Toolbar';
import type { ReactNode } from 'react';
export function ActionToolbar({
  label,
  children,
}: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <Toolbar role="toolbar" aria-label={label} disableGutters className="ui-action-toolbar">
      {children}
    </Toolbar>
  );
}
