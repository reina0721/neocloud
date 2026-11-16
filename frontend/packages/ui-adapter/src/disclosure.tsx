'use client';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import type { ReactNode } from 'react';
export type DisclosurePanelProps = Readonly<{
  title: string;
  children: ReactNode;
  description?: string;
  defaultExpanded?: boolean;
  disabled?: boolean;
}>;

/** DisclosurePanel 表达可展开的补充内容，不承担页面导航或业务状态。 */

export function DisclosurePanel({
  title,
  children,
  description,
  defaultExpanded = false,
  disabled = false,
}: DisclosurePanelProps) {
  return (
    <Accordion
      disableGutters
      defaultExpanded={defaultExpanded}
      disabled={disabled}
      className="rounded-panel border border-border bg-surface"
    >
      <AccordionSummary
        className="px-4 py-1"
        expandIcon={
          <svg
            aria-hidden="true"
            className="size-4 text-ink-muted"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
          >
            <path d="m4 6 4 4 4-4" />
          </svg>
        }
      >
        <span>
          <span className="block text-sm font-semibold text-ink">{title}</span>
          {description ? (
            <span className="mt-1 block text-sm text-ink-muted">{description}</span>
          ) : null}
        </span>
      </AccordionSummary>
      <AccordionDetails className="border-t border-border px-4 py-3 text-sm leading-6 text-ink-muted">
        {children}
      </AccordionDetails>
    </Accordion>
  );
}
