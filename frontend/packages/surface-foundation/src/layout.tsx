import { ActionToolbar } from '@clouddrive/ui-adapter/action-toolbar';
import { BreadcrumbTrail } from '@clouddrive/ui-adapter/navigation';
import { Panel } from '@clouddrive/ui-adapter/panel';
import type { ReactNode } from 'react';
import { ViewportReveal } from './viewport-reveal';

export function Page({
  children,
  density,
}: Readonly<{ children: ReactNode; density?: 'compact' }>) {
  return (
    <ViewportReveal
      items
      className={
        density === 'compact'
          ? 'surface-page-stack surface-page-stack-compact'
          : 'surface-page-stack'
      }
    >
      {children}
    </ViewportReveal>
  );
}

export type BreadcrumbItem = Readonly<{
  label: string;
  current?: boolean;
  content?: ReactNode;
}>;

export type PageHeaderProps = Readonly<{
  eyebrow?: string;
  title: string;
  titleId?: string;
  description?: string;
  breadcrumbs?: readonly BreadcrumbItem[];
  breadcrumbLabel?: string;
  actions?: ReactNode;
  density?: 'compact';
}>;

export function PageHeader({
  eyebrow,
  title,
  titleId,
  description,
  breadcrumbs,
  breadcrumbLabel,
  actions,
  density,
}: PageHeaderProps) {
  const compact = density === 'compact';
  return (
    <header
      data-reveal-item
      className={`surface-page-header surface-route-region ${compact ? 'space-y-1' : 'space-y-2 sm:space-y-4'}`}
    >
      {breadcrumbs && breadcrumbLabel ? (
        <BreadcrumbTrail
          items={breadcrumbs.map((item, index) => ({
            id: `breadcrumb-${index}`,
            label: item.label,
            ...(item.content && !item.current ? { content: item.content } : {}),
          }))}
          label={breadcrumbLabel}
        />
      ) : null}
      <div
        className={`flex flex-wrap justify-between ${compact ? 'items-center gap-2' : 'items-end gap-5'}`}
      >
        <div className="min-w-0 max-w-3xl">
          {eyebrow ? (
            <p className="hidden text-xs font-bold uppercase tracking-widest text-brand sm:block">
              {eyebrow}
            </p>
          ) : null}
          <h1
            id={titleId}
            className={
              compact
                ? `${eyebrow ? 'sm:mt-1' : ''} break-words text-xl font-semibold tracking-tight text-ink sm:text-2xl`
                : `${eyebrow ? 'sm:mt-3' : ''} text-balance text-xl font-bold tracking-tight text-brand sm:text-3xl`
            }
          >
            {title}
          </h1>
          {description || !compact ? (
            <p
              className={`text-sm text-ink-muted ${compact ? 'mt-0.5 leading-5' : 'mt-1 leading-6 sm:mt-2 sm:leading-7'}`}
            >
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Toolbar({
  label,
  primary,
  secondary,
  inset = 'standard',
  embedded = false,
}: Readonly<{
  label: string;
  primary: ReactNode;
  secondary?: ReactNode;
  inset?: 'standard' | 'compact';
  embedded?: boolean;
}>) {
  return (
    <div
      className={
        embedded
          ? 'surface-toolbar-embedded'
          : `surface-toolbar rounded-panel bg-surface ${inset === 'compact' ? 'p-1' : 'p-3'}`
      }
    >
      <ActionToolbar label={label}>
        {embedded && primary === null ? null : (
          <div className="surface-toolbar-primary flex min-w-0 flex-wrap items-center gap-2">
            {primary}
          </div>
        )}
        {secondary ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{secondary}</div>
        ) : null}
      </ActionToolbar>
    </div>
  );
}

export function FilterBar({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="surface-filter-grid rounded-panel bg-surface-muted p-3">{children}</div>;
}

/**
 * SectionBody —— Panel/Section 内容区 body 的统一 horizontal inset。
 *
 * 组合职责：section 场景（如 `TabsView variant="section"` 作章节导航 + 内容）需要
 * TabList 与内容共享父容器左右内容边界、并具备稳定上下间距。此 wrapper 只提供
 * 统一 inset，不创建 Surface/divider（由父 Panel/Section 决定区域分隔）。
 * 供 Section（contentInset）与自定义 header 的 Panel body 复用，
 * 避免各调用方手写 px/py。
 */
export function SectionBody({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="px-3 py-3 sm:px-6 sm:py-5">{children}</div>;
}

export type SectionProps = Readonly<{
  id?: string;
  title: ReactNode;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  appearance?: 'elevated' | 'outlined' | 'embedded';
  density?: 'compact';
  /**
   * true 时 children 包进 SectionBody（统一 horizontal inset + 稳定上下间距），
   * 供需要“章节导航 + 内容共享父容器内容边界”的组合（如 `TabsView variant="section"`）。
   * 默认 false 保持既有 flush children 行为（不影响现有调用方）。
   */
  contentInset?: boolean;
}>;

export function Section({
  id,
  title,
  description,
  action,
  children,
  appearance = 'elevated',
  contentInset = false,
  density,
}: SectionProps) {
  const compact = density === 'compact';
  const section = (
    <Panel appearance={appearance} className="surface-route-region overflow-hidden">
      <div
        data-reveal-item
        className={`flex flex-wrap justify-between border-b border-border ${compact ? 'items-center gap-2 px-3 py-2 sm:px-4' : 'items-start gap-3 px-5 py-4'}`}
      >
        <div className="min-w-0">
          <h2 className={`font-semibold ${compact ? 'text-sm text-ink' : 'text-base text-brand'}`}>
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-sm leading-6 text-ink-muted">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      <div data-reveal-item>
        {contentInset ? (
          compact ? (
            <div className="px-3 py-2 sm:px-4">{children}</div>
          ) : (
            <SectionBody>{children}</SectionBody>
          )
        ) : (
          children
        )}
      </div>
    </Panel>
  );

  return id ? (
    <div className="surface-route-region scroll-mt-24" id={id}>
      {section}
    </div>
  ) : (
    section
  );
}

export function SplitView({ master, detail }: Readonly<{ master: ReactNode; detail: ReactNode }>) {
  return (
    <div className="surface-split-view">
      <div className="min-w-0">{master}</div>
      <aside className="surface-split-detail">{detail}</aside>
    </div>
  );
}

export function StickyActions({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <footer className="sticky bottom-3 z-shell flex flex-wrap items-center justify-end gap-3 rounded-panel border border-border bg-surface/95 px-4 py-3 shadow-overlay backdrop-blur-xl">
      {children}
    </footer>
  );
}

/** 已登录工作区共享顶栏。路由、搜索和身份操作由各工作区提供。 */
export function WorkspaceHeader({
  brand,
  navigation,
  search,
  searchMode = 'inline',
  tools,
  account,
}: Readonly<{
  brand: ReactNode;
  navigation?: ReactNode;
  search?: ReactNode;
  searchMode?: 'inline' | 'below' | 'desktop';
  tools?: ReactNode;
  account: ReactNode;
}>) {
  return (
    <header
      data-workspace-header
      className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-2 border-b border-border bg-surface px-3 md:flex-nowrap md:gap-3 md:px-6"
    >
      <div className="flex surface-workspace-mainline min-w-0 flex-1 items-center gap-2 md:flex-none">
        {navigation ? <div className="flex shrink-0 items-center gap-1">{navigation}</div> : null}
        {brand}
      </div>
      {search ? (
        <div
          className={
            searchMode === 'below'
              ? 'order-last flex h-14 min-w-0 basis-full items-center md:order-none md:h-auto md:basis-auto md:flex-1'
              : searchMode === 'desktop'
                ? 'hidden min-w-0 flex-1 md:block'
                : 'min-w-0 flex-1'
          }
        >
          {search}
        </div>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {tools}
        {account}
      </div>
    </header>
  );
}

export function WorkspaceBrand({
  name,
  scope,
  mark,
}: Readonly<{ name: string; scope?: string; mark: ReactNode }>) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="grid size-6 shrink-0 place-items-center rounded-control bg-brand-soft text-brand">
        {mark}
      </span>
      <span className="max-w-40 truncate text-sm font-bold text-ink" title={name}>
        {name}
      </span>
      {scope ? (
        <span className="hidden shrink-0 rounded-action bg-surface-muted px-2 py-0.5 text-xs font-medium text-ink-muted lg:inline">
          {scope}
        </span>
      ) : null}
    </div>
  );
}

/** 产品横幅只拥有视觉与内容槽；品牌、文案及业务动作由消费方提供。 */
export function ProductMasthead({
  name,
  description,
  aside,
}: Readonly<{
  name: string;
  description: string;
  aside?: ReactNode;
}>) {
  return (
    <div className="surface-masthead">
      <div className="surface-masthead-copy">
        <p className="surface-wordmark">
          {name}
          <span aria-hidden="true">✦</span>
        </p>
        <p className="surface-masthead-description">{description}</p>
      </div>
      {aside ? <div className="surface-masthead-aside">{aside}</div> : null}
      <span className="surface-masthead-orbit" aria-hidden="true" />
      <span className="surface-masthead-stars" aria-hidden="true">
        ＋ ＋ ＋<br />＋ ＋ ＋
      </span>
    </div>
  );
}
