'use client';
import { useSearchParams } from 'next/navigation';
import { UserEditorPage } from '../../src/user-editor-page';
export default function EditUserRoute() {
  const params = useSearchParams();
  return <UserEditorPage id={params.get('id') ?? ''} listContext={params.get('list')} />;
}
