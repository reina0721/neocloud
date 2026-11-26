'use client';
import { useSearchParams } from 'next/navigation';
import { UserDetailPage } from '../../src/user-detail-page';
export default function UserDetailRoute() {
  const params = useSearchParams();
  return <UserDetailPage id={params.get('id')} listContext={params.get('list')} />;
}
