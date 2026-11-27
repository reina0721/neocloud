'use client';
import { Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useFrontendTranslation } from '@neocloud/i18n';
import { PageLoadingSurface } from '@neocloud/surface-foundation/states-operations';
import { Skeleton } from '@neocloud/ui-adapter/skeleton';
import { FormElementsPage } from '../../src/form-elements-page';

const DatePickerField = dynamic(
  () => import('@neocloud/ui-adapter/date-picker-field').then((module) => module.DatePickerField),
  { ssr: false, loading: () => <Skeleton className="h-control w-full" /> },
);

export default function FormElementsRoute() {
  const { t } = useFrontendTranslation();
  return (
    <Suspense fallback={<PageLoadingSurface kind="form" label={t('uiElements.fieldsTitle')} />}>
      <FormElementsPage datePicker={DatePickerField} />
    </Suspense>
  );
}
