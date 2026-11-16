import Paper from '@mui/material/Paper';
import type { HTMLAttributes, ReactNode } from 'react';

export type CardProps = Readonly<{
  children: ReactNode;
  appearance?: 'elevated' | 'outlined' | 'flat';
}> &
  Pick<HTMLAttributes<HTMLElement>, 'aria-label' | 'role'>;

export function Card({ children, appearance = 'elevated', ...aria }: CardProps) {
  return (
    <Paper
      component="section"
      elevation={0}
      className={`ui-card overflow-hidden rounded-panel border text-ink ${appearance === 'elevated' ? 'border-transparent bg-surface shadow-panel' : appearance === 'flat' ? 'border-transparent bg-surface-muted shadow-none' : 'border-border bg-surface shadow-none'}`}
      {...aria}
    >
      {children}
    </Paper>
  );
}

export type CardHeaderProps = Readonly<{
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}>;

export function CardHeader({ title, description, action }: CardHeaderProps) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-brand">{title}</h3>
        {description ? (
          <p className="mt-1 text-sm leading-6 text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function CardContent({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="p-5">{children}</div>;
}

export function CardFooter({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-5 py-4">
      {children}
    </footer>
  );
}
