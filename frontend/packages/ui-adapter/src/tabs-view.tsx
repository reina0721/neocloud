import MuiTabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { useId, useState, startTransition, type ReactNode } from 'react';
import { useNarrowLayout } from './browser-layout';
import { ContentSwapTransition } from './content-swap-transition';
import { Badge } from './feedback';
export type TabsViewItem = Readonly<{
  id: string;
  label: string;
  content: ReactNode;
  disabled?: boolean;
  /** 受控 leading icon；wrapper 的尺寸、颜色继承与 aria-hidden 由 TabsView 负责。 */
  icon?: ReactNode;
  /** 受控 count/短元数据；由 TabsView 用 Badge primitive 统一渲染。 */
  badge?: number | string;
}>;

/**
 * TabsView 的稳定语义 Variant（仅表达「同一内容域中的内容切换」语义）。
 *
 * Visual Variant：
 * - `line`（默认）：普通内容导航。TabList 透明、无独立 Surface、无胶囊；
 *   底部允许一条非常轻的 baseline；selected 用 brand foreground + 底部 brand indicator。
 * - `section`：Card / Form / Settings / Panel 内部章节导航。视觉语言与 line 一致
 *   （透明 TabList、不创建灰色 Toolbar、不拥有独立 rounded Surface、不强制整条
 *   baseline），spacing 更适合嵌入已有 Surface；内容分隔由父容器决定。
 * - `soft`：希望 TabList 自身形成轻量选择区域。TabList 用非常轻的 semantic muted
 *   surface + 受控小圆角 + 紧凑 padding；selected Tab 用独立 elevated/default surface
 *   凸显；不使用 line underline、不做夸张胶囊。语义仍是内容切换，不是值/模式选择
 *   （后者用 ToggleGroup）。
 *
 * Orientation：`horizontal`（默认）| `vertical`。Vertical 不创建新业务 Variant，
 * 只改变 indicator/布局表达；窄 viewport 自动回退为顶部横向可滚动 TabList。
 *
 * 视觉职责边界：本组件是 Tabs 最终视觉的所有者（background/foreground/border/
 * indicator/radius/spacing/shadow/focus/hover/selected 均通过 semantic token 表达），
 * 不向业务暴露 MUI visual variant，也不提供可覆盖 TabList 视觉的通用 className
 * 逃生口；长期布局需求通过受控 semantic props 扩展。
 */
export type TabsViewVariant = 'line' | 'section' | 'soft';
export type TabsViewOrientation = 'horizontal' | 'vertical';

export type TabsViewProps = Readonly<{
  label: string;
  items: readonly TabsViewItem[];
  selectedId?: string;
  onSelectionChange?: (id: string) => void;
  variant?: TabsViewVariant;
  orientation?: TabsViewOrientation;
}>;

export function TabsView({
  label,
  items,
  selectedId,
  onSelectionChange,
  variant = 'line',
  orientation = 'horizontal',
}: TabsViewProps) {
  const narrow = useNarrowLayout();
  const vertical = orientation === 'vertical' && !narrow;
  const [internal, setInternal] = useState(items.find((item) => !item.disabled)?.id ?? '');
  const [changed, setChanged] = useState(false);
  const id = useId();
  const selected =
    items.find((item) => item.id === (selectedId ?? internal) && !item.disabled)?.id ??
    items.find((item) => !item.disabled)?.id ??
    false;
  return (
    <div
      className={
        vertical ? 'flex w-full flex-col gap-4 md:flex-row md:items-start' : 'min-w-0 w-full'
      }
    >
      <MuiTabs
        aria-label={label}
        data-ui-tabs={variant}
        value={selected}
        orientation={vertical ? 'vertical' : 'horizontal'}
        variant="scrollable"
        scrollButtons="auto"
        selectionFollowsFocus
        className={vertical ? 'min-w-0 md:w-48 md:shrink-0' : 'min-w-0 w-full'}
        slotProps={{
          list: {
            className:
              variant === 'soft'
                ? 'rounded-control bg-surface-muted p-1'
                : `rounded-none bg-transparent p-0 ${variant === 'line' && !vertical ? 'border-b border-border' : ''}`,
          },
          indicator: { className: `ui-tabs-indicator ${variant === 'soft' ? 'hidden' : ''}` },
        }}
        onChange={(_, next: string) =>
          startTransition(() => {
            if (next !== selected) setChanged(true);
            if (selectedId === undefined) setInternal(next);
            onSelectionChange?.(next);
          })
        }
      >
        {items.map((item) => (
          <Tab
            key={item.id}
            value={item.id}
            id={id + '-tab-' + item.id}
            aria-controls={id + '-panel-' + item.id}
            disabled={item.disabled}
            className={`${variant === 'soft' ? 'min-h-control-sm rounded-control bg-transparent aria-selected:bg-surface aria-selected:shadow-panel' : ''} ${vertical ? 'justify-start text-start' : ''}`}
            label={
              <span className="inline-flex items-center gap-1.5">
                {item.icon ? (
                  <span
                    aria-hidden="true"
                    className="grid size-icon-sm shrink-0 place-items-center"
                  >
                    {item.icon}
                  </span>
                ) : null}
                <span>{item.label}</span>
                {item.badge !== undefined ? (
                  <Badge tone="neutral">{String(item.badge)}</Badge>
                ) : null}
              </span>
            }
          />
        ))}
      </MuiTabs>
      {items.map((item) =>
        item.id === selected ? (
          <div
            role="tabpanel"
            tabIndex={0}
            id={id + '-panel-' + item.id}
            aria-labelledby={id + '-tab-' + item.id}
            key={item.id}
            className={`mt-3 min-w-0 outline-none ${vertical ? 'flex-1' : ''}`}
          >
            <ContentSwapTransition contentKey={String(selected)} initialChange={changed}>
              <>{item.content}</>
            </ContentSwapTransition>
          </div>
        ) : null,
      )}
    </div>
  );
}
