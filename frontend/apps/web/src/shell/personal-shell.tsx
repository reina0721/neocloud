'use client';
import './install-translations';
import { ShellNavigationViewProvider } from '@clouddrive/surface/shell/runtime';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { PluginLocaleProvider } from '@clouddrive/plugin-framework/plugin';
import { usePreferencesPort } from '@clouddrive/plugin-framework/preferences';
import type { Preferences } from '@clouddrive/surface/preferences-model';
import { CurrentSiteLogo, useSiteProfile } from '@clouddrive/surface/administration/runtime';
import { IconAction } from '@clouddrive/ui-adapter/icon-action';
import { NavigationItem } from '@clouddrive/ui-adapter/destination-navigation';
import { WorkspaceBrand, WorkspaceHeader } from '@clouddrive/surface-foundation/layout';
import { DrawerSurface } from '@clouddrive/ui-adapter/overlays';
import {
  ArrowLeft,
  Bell,
  ChevronDown,
  ChevronRight,
  Cloud,
  Globe,
  KeyRound,
  Menu,
  Palette,
  Settings,
  Shield,
  Sliders,
  UserRound,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { HostNavigationPortProvider } from '../host/navigation-port';
import { proceedAfterLeaveConfirm } from '../host/leave-confirm';
import { routeTargetResolver } from '../host/route-target-resolver';
import { RouteTransition } from '../host/route-transition';
import { markForwardRouteIntent, pageTransitionTypes } from '../host/route-transition-constants';
import { resolveScrollOption } from '../host/scroll-preference';
import { TopProgress } from '../host/top-progress';
import { useShellStore } from '../state/use-shell-store';
import { NotificationAlerts } from '../host/notification-alerts';
import { NotificationCenter } from './notification-center';
import { useNavigationLabelOverrides, useProductNavigation } from './use-product-navigation';

const AccountMenu = dynamic(() => import('./account-menu').then((module) => module.AccountMenu), {
  ssr: false,
});

type NavLinkItem = Readonly<{
  href: string;
  labelZh: string;
  labelEn: string;
  icon: ReactNode;
  exact?: boolean;
}>;

const accountLinks: readonly NavLinkItem[] = [
  {
    href: '/account',
    labelZh: '个人账户',
    labelEn: 'Account',
    icon: <UserRound className="size-4 shrink-0" />,
    exact: true,
  },
  {
    href: '/account/security',
    labelZh: '安全设置',
    labelEn: 'Security',
    icon: <Shield className="size-4 shrink-0" />,
  },
  {
    href: '/account/tokens',
    labelZh: 'API 令牌',
    labelEn: 'API tokens',
    icon: <KeyRound className="size-4 shrink-0" />,
  },
  {
    href: '/notifications',
    labelZh: '通知中心',
    labelEn: 'Notifications',
    icon: <Bell className="size-4 shrink-0" />,
  },
];

const preferenceLinks: readonly NavLinkItem[] = [
  {
    href: '/settings',
    labelZh: '外观与显示',
    labelEn: 'Appearance',
    icon: <Palette className="size-4 shrink-0" />,
    exact: true,
  },
  {
    href: '/settings/locale',
    labelZh: '语言与地区',
    labelEn: 'Language & region',
    icon: <Globe className="size-4 shrink-0" />,
  },
  {
    href: '/settings/actions',
    labelZh: '操作偏好',
    labelEn: 'Behavior',
    icon: <Sliders className="size-4 shrink-0" />,
  },
  {
    href: '/settings/security',
    labelZh: '隐私与锁屏',
    labelEn: 'Privacy & lock',
    icon: <Shield className="size-4 shrink-0" />,
  },
];

const advancedPreferenceLinks: readonly NavLinkItem[] = [
  {
    href: '/settings/notifications',
    labelZh: '通知提醒',
    labelEn: 'Notification alerts',
    icon: <Bell className="size-4 shrink-0" />,
  },
  {
    href: '/settings/shortcuts',
    labelZh: '快捷键',
    labelEn: 'Shortcuts',
    icon: <Settings className="size-4 shrink-0" />,
  },
  {
    href: '/settings/accessibility',
    labelZh: '可访问性',
    labelEn: 'Accessibility',
    icon: <Settings className="size-4 shrink-0" />,
  },
  {
    href: '/settings/data-display',
    labelZh: '数据展示',
    labelEn: 'Data display',
    icon: <Settings className="size-4 shrink-0" />,
  },
  {
    href: '/settings/navigation',
    labelZh: '高级导航',
    labelEn: 'Advanced navigation',
    icon: <Settings className="size-4 shrink-0" />,
  },
];

function usePersonalNavigate() {
  const router = useRouter();
  return (href: string, onAccepted?: () => void) => {
    void proceedAfterLeaveConfirm(href).then((proceed) => {
      if (!proceed) {
        if (href === location.pathname + location.search + location.hash) onAccepted?.();
        return;
      }
      onAccepted?.();
      markForwardRouteIntent();
      void router.push(href, {
        transitionTypes: [pageTransitionTypes.forward],
        ...resolveScrollOption(),
      });
    });
  };
}

function PersonalLink({
  href,
  className,
  label,
  onAccepted,
  children,
}: Readonly<{
  href: string;
  className: string;
  label?: string;
  onAccepted?: (() => void) | undefined;
  children: ReactNode;
}>) {
  const navigate = usePersonalNavigate();
  return (
    <Link
      href={href}
      className={className}
      aria-label={label}
      onNavigate={(event) => {
        event.preventDefault();
        navigate(href, onAccepted);
      }}
    >
      {children}
    </Link>
  );
}

function PersonalNav({
  pathname,
  zh,
  canAdmin,
  onNavigate,
}: Readonly<{
  pathname: string;
  zh: boolean;
  canAdmin: boolean;
  onNavigate?: () => void;
}>) {
  const navigate = usePersonalNavigate();
  const isAdvancedActive = advancedPreferenceLinks.some((item) => pathname === item.href);
  const [advancedOpen, setAdvancedOpen] = useState(isAdvancedActive);
  const renderLink = (item: NavLinkItem) => {
    const active = item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`);
    return (
      <NavigationItem
        key={item.href}
        href={item.href}
        label={zh ? item.labelZh : item.labelEn}
        icon={item.icon}
        selected={active}
        onNavigate={() => navigate(item.href, onNavigate)}
      />
    );
  };

  return (
    <nav
      aria-label={zh ? '个人中心导航' : 'Personal navigation'}
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-4"
    >
      <div className="space-y-1">
        <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {zh ? '账户' : 'Account'}
        </p>
        {accountLinks.map(renderLink)}
      </div>
      <div className="space-y-1">
        <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {zh ? '偏好设置' : 'Preferences'}
        </p>
        {preferenceLinks.map(renderLink)}
        <button
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((value) => !value)}
          className="mt-1 flex w-full items-center gap-2 rounded-control px-3 py-2 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
        >
          {advancedOpen ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          <span>{zh ? '更多界面选项' : 'More options'}</span>
        </button>
        {advancedOpen ? (
          <div className="space-y-0.5 pl-2">{advancedPreferenceLinks.map(renderLink)}</div>
        ) : null}
      </div>
      {canAdmin ? (
        <div className="mt-auto border-t border-border pt-3">
          <PersonalLink
            href="/workspace"
            onAccepted={onNavigate}
            className="flex items-center justify-between gap-2 rounded-control px-3 py-2 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-muted hover:text-brand"
          >
            <span>{zh ? '进入管理面板' : 'Admin console'}</span>
            <ChevronRight className="size-3.5 shrink-0" />
          </PersonalLink>
        </div>
      ) : null}
    </nav>
  );
}

export function PersonalShell({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  const router = useRouter();
  const { t, locale: activeLocale } = useFrontendTranslation();
  const zh = activeLocale.startsWith('zh');
  const { profile } = useSiteProfile();
  const siteName = profile?.name || t('brand.name');
  const locale = useShellStore((state) => state.locale);
  const preferencesPort = usePreferencesPort<Preferences>();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigation = useProductNavigation();
  const labelOverrides = useNavigationLabelOverrides();
  const canAdmin = navigation.groups.some(
    (group) => group.id === 'management' || group.id === 'administration',
  );

  return (
    <div className="flex min-h-dvh flex-col bg-canvas font-sans text-ink">
      <NotificationAlerts />
      <TopProgress />
      <div className="sticky top-0 z-sticky">
        <WorkspaceHeader
          navigation={
            <>
              <div className="lg:hidden">
                <IconAction
                  size="sm"
                  label={zh ? '打开个人菜单' : 'Open personal menu'}
                  onPress={() => setMobileOpen(true)}
                >
                  <Menu className="size-5" />
                </IconAction>
              </div>
              <PersonalLink
                href="/home"
                label={zh ? '返回我的文件' : 'Back to files'}
                className="inline-flex h-control-sm items-center gap-1 rounded-action border border-border bg-surface px-2 text-xs font-medium text-ink hover:bg-surface-muted hover:text-brand focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <ArrowLeft className="size-4 shrink-0" />
                <span className="sm:hidden">{zh ? '返回' : 'Files'}</span>
                <span className="hidden sm:inline">{zh ? '返回我的文件' : 'Back to files'}</span>
              </PersonalLink>
            </>
          }
          brand={
            <PersonalLink
              href="/home"
              label={siteName + ' ' + (zh ? '个人中心' : 'Personal')}
              className="min-w-0"
            >
              <WorkspaceBrand
                name={siteName}
                scope={zh ? '个人中心' : 'Personal'}
                mark={
                  <CurrentSiteLogo className="size-5" fallback={<Cloud className="size-4" />} />
                }
              />
            </PersonalLink>
          }
          account={
            <>
              <NotificationCenter />
              <AccountMenu
                compact={false}
                onNavigate={(destination) => {
                  if (destination === 'lock-screen') {
                    window.dispatchEvent(new Event('clouddrive:lock'));
                    return;
                  }
                  const href = routeTargetResolver.resolveHref({
                    routeId: destination,
                    params: {},
                  });
                  void proceedAfterLeaveConfirm(href, t('shell.account')).then((proceed) => {
                    if (!proceed) return;
                    markForwardRouteIntent();
                    void router.push(href, {
                      transitionTypes: [pageTransitionTypes.forward],
                      ...resolveScrollOption(),
                    });
                  });
                }}
              />
            </>
          }
        />
      </div>

      <div className="mx-auto flex w-full max-w-screen-xl flex-1 min-h-0">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface/60 lg:flex">
          <div className="sticky top-14 flex flex-col">
            <PersonalNav pathname={pathname} zh={zh} canAdmin={canAdmin} />
          </div>
        </aside>

        <DrawerSurface
          triggerLabel={zh ? '个人中心导航' : 'Personal navigation'}
          title={zh ? '个人中心' : 'Personal'}
          description={siteName}
          closeLabel={t('shell.closeNav')}
          isOpen={mobileOpen}
          onOpenChange={setMobileOpen}
          placement="left"
          composition="navigation"
        >
          <PersonalNav
            pathname={pathname}
            zh={zh}
            canAdmin={canAdmin}
            onNavigate={() => setMobileOpen(false)}
          />
        </DrawerSurface>

        <main id="main-content" className="min-w-0 flex-1 px-4 py-6 sm:px-8 lg:py-8">
          <RouteTransition>
            <PluginLocaleProvider
              port={{
                locale,
                changeLocale: (next) => {
                  if (next === 'en' || next === 'zh-CN')
                    preferencesPort.updateCategory('localeRegion', { language: next });
                },
              }}
            >
              <HostNavigationPortProvider resolveHref={routeTargetResolver.resolveHref}>
                <ShellNavigationViewProvider
                  groups={navigation.groups}
                  labels={labelOverrides}
                  status={navigation.status}
                  onReload={navigation.reload}
                >
                  {children}
                </ShellNavigationViewProvider>
              </HostNavigationPortProvider>
            </PluginLocaleProvider>
          </RouteTransition>
        </main>
      </div>
    </div>
  );
}
