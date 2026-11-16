'use client';
import { lazy, Suspense } from 'react';
import { Skeleton } from './skeleton';
const MaterialDatePicker = lazy(() => import('./date-picker-calendar'));
export type DatePickerFieldProps = Readonly<{
  label: string;
  hint?: string;
  calendarLabel: string;
  disabled?: boolean;
  defaultOpen?: boolean;
  /** Calendar date, never an instant or browser-local timezone conversion. */
  value?: string | null;
  onValueChange?: (value: string | null) => void;
}>;
export function DatePickerField(props: DatePickerFieldProps) {
  return (
    <Suspense
      fallback={
        <div role="status" aria-label={props.label}>
          <Skeleton className="h-control w-full" />
        </div>
      }
    >
      <MaterialDatePicker {...props} />
    </Suspense>
  );
}
