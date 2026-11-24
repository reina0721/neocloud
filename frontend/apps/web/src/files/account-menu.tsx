'use client';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { AccountMenu } from '../shell/account-menu';
import { routeTargetResolver } from '../host/route-target-resolver';
import { requestLock } from '../shell/use-idle-lock';

const NotificationCenter = dynamic(
  () => import('../shell/notification-center').then((module) => module.NotificationCenter),
  { ssr: false },
);

export function FileAccountMenu() {
  const router = useRouter();
  return (
    <div className="flex items-center gap-1">
      <NotificationCenter />
      <AccountMenu
        compact
        presentation="avatar"
        onNavigate={(destination) => {
          if (destination === 'lock-screen') requestLock();
          else router.push(routeTargetResolver.resolveHref({ routeId: destination, params: {} }));
        }}
      />
    </div>
  );
}
