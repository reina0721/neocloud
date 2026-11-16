'use client';
import MuiLink from '@mui/material/Link';
import type { MouseEvent, ReactNode } from 'react';
export type TextLinkProps = Readonly<{
  children: ReactNode;
  href: string;
  external?: boolean;
  tone?: 'brand' | 'neutral';
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  onNavigate?: () => void;
}>;

export function TextLink({
  children,
  href,
  external = false,
  tone = 'brand',
  leadingIcon,
  trailingIcon,
  onNavigate,
}: TextLinkProps) {
  return (
    <MuiLink
      className={`inline-flex items-center gap-1.5 rounded-control font-semibold underline-offset-4 outline-none hover:underline ${tone === 'brand' ? 'text-brand hover:text-brand-strong' : 'text-ink-muted hover:text-ink'}`}
      href={href}
      {...(onNavigate
        ? {
            onClick: (event: MouseEvent<Element>) => {
              if (
                event.button !== 0 ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              onNavigate();
            },
          }
        : {})}
      {...(external ? { rel: 'noreferrer', target: '_blank' } : {})}
    >
      {leadingIcon ? (
        <span aria-hidden="true" className="grid size-icon-sm place-items-center">
          {leadingIcon}
        </span>
      ) : null}
      <span>{children}</span>
      {trailingIcon ? (
        <span aria-hidden="true" className="grid size-icon-sm place-items-center">
          {trailingIcon}
        </span>
      ) : null}
    </MuiLink>
  );
}
