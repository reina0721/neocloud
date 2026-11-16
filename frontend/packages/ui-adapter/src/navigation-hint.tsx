import Tooltip from '@mui/material/Tooltip';
import { isValidElement, type ReactNode } from 'react';
export default function NavigationHintContent({
  label,
  children,
}: Readonly<{ label: string; children: ReactNode }>) {
  return isValidElement(children) ? (
    <Tooltip title={label} placement="right" enterDelay={300} arrow>
      {children}
    </Tooltip>
  ) : (
    children
  );
}
