'use client';
import { BackendOnly } from '../../../../src/administration/resource-state';
import { SystemUpdatePage } from '../../src/system-update-page';

export default function Route() {
  return (
    <BackendOnly>
      <SystemUpdatePage />
    </BackendOnly>
  );
}
