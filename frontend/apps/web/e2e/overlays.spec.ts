import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { waitForVisualReadiness } from './visual-readiness';

async function assertOverlayAccessibility(page: Page) {
  await waitForVisualReadiness(page);
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

async function readThemeRoles(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  await waitForVisualReadiness(page);
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.visibility = 'hidden';
    document.body.append(probe);
    try {
      const color = (role: string) => {
        probe.style.color = `var(--color-${role})`;
        return getComputedStyle(probe).color;
      };
      return {
        surface: color('surface'),
        muted: color('surface-muted'),
        brand: color('brand'),
        ink: color('ink'),
      };
    } finally {
      probe.remove();
    }
  });
}

async function assertMatchesTriggerWidth(page: Page, trigger: Locator) {
  const popup = page.getByRole('listbox');
  await expect
    .poll(async () => {
      const [overlay, anchor] = await Promise.all([
        popup.evaluate((element) => ({
          width: element.closest('.ui-overlay-surface')!.getBoundingClientRect().width,
        })),
        trigger.evaluate((element) => ({
          width: element.closest('.MuiInputBase-root')!.getBoundingClientRect().width,
        })),
      ]);
      return overlay && anchor ? Math.abs(overlay.width - anchor.width) : Infinity;
    })
    .toBeLessThanOrEqual(1);
}

async function assertListboxScrolls(page: Page) {
  const listbox = page.getByRole('listbox');
  await expect(listbox).toHaveCSS('overflow-y', 'auto');
  const initialMetrics = await listbox.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  expect(initialMetrics.scrollHeight).toBeGreaterThan(initialMetrics.clientHeight);
  expect(initialMetrics.scrollTop).toBe(0);

  await page.keyboard.press('End');
  const scrolledTop = await listbox.evaluate((element) => element.scrollTop);
  expect(scrolledTop).toBeGreaterThan(0);
}

test('九个 Family 页面逐项公开全部 UI Element', async ({ page }) => {
  test.setTimeout(60_000);
  const families = [
    {
      path: '/ui-elements/actions-selection',
      elements: ['Action', 'IconAction', 'ToggleGroup'],
    },
    {
      path: '/ui-elements/feedback',
      elements: ['AlertBanner', 'Badge', 'NotificationCard', 'FeedbackProvider / Toast'],
    },
    {
      path: '/ui-elements/status-async',
      elements: [
        'StatusPill',
        'ProgressMeter',
        'BusyIndicator',
        'Skeleton',
        'StateSurface',
        'LiveRegion',
        'SkipLink',
      ],
    },
    {
      path: '/ui-elements/identity-display',
      elements: ['Avatar', 'UserIdentity', 'ReadyImage', 'DescriptionList'],
    },
    {
      path: '/ui-elements/navigation',
      elements: [
        'NavigationItem',
        'NavigationTabs',
        'TextLink',
        'BreadcrumbTrail',
        'PaginationControl',
        'TabsView',
        'StepNavigation',
        'Tree',
        'DisclosurePanel',
      ],
    },
    { path: '/ui-elements/data', elements: ['DataTable'] },
    {
      path: '/ui-elements/surfaces',
      elements: ['Card / CardHeader / CardContent / CardFooter', 'Panel'],
    },
    {
      path: '/ui-elements/forms',
      elements: [
        'TextField',
        'TextAreaField',
        'SearchBox',
        'SelectField',
        'ComboField',
        'DatePickerField',
        'CheckboxField',
        'RadioGroupField',
        'SwitchField',
        'FormErrorSummary',
      ],
    },
    {
      path: '/ui-elements/overlays',
      elements: [
        'MenuButton',
        'PopoverCard',
        'TooltipAction',
        'DialogSurface',
        'ConfirmDialog',
        'DestructiveConfirmDialog',
        'DrawerSurface',
        'CommandMenu',
      ],
    },
  ] as const;

  expect(families.flatMap(({ elements }) => elements)).toHaveLength(48);
  for (const family of families) {
    await page.goto(family.path);
    await expect(
      page.getByRole('navigation', { name: 'UI Elements 分类导航' }).getByRole('link'),
    ).toHaveCount(9);
    await expect(page.getByText('公开 Element 48 / 48')).toBeVisible();
    for (const element of family.elements) {
      await expect(page.getByRole('heading', { level: 3, name: element, exact: true })).toHaveCount(
        1,
      );
      await expect(page.getByLabel(`${element} 状态`, { exact: true })).toBeAttached();
    }
    await assertOverlayAccessibility(page);
  }
});

test('Action 区分可操作、Pending 与 Disabled 状态', async ({ page }) => {
  await page.goto('/ui-elements/actions-selection');
  const primary = page.getByRole('button', { name: '主要操作' });
  const small = page.getByRole('button', { name: '小尺寸' });
  const loading = page.getByRole('button', { name: '处理中', exact: true });
  const disabled = page.getByRole('button', { name: '不可用', exact: true });

  await expect(primary).toBeEnabled();
  await primary.focus();
  await expect(primary).toBeFocused();

  const primaryHeight = await primary.evaluate((element) => element.getBoundingClientRect().height);
  const smallHeight = await small.evaluate((element) => element.getBoundingClientRect().height);
  expect(smallHeight).toBeLessThan(primaryHeight);

  await expect(loading).toHaveAttribute('data-pending', 'true');
  await expect(loading).toHaveAttribute('aria-disabled', 'true');
  await expect(loading).toBeDisabled();
  await expect(disabled).not.toHaveAttribute('data-pending');
  await expect(disabled).toBeDisabled();
  await assertOverlayAccessibility(page);
});

test('ToggleGroup 与 DataTable 状态矩阵具有真实联动', async ({ page }) => {
  await page.goto('/ui-elements/actions-selection');
  const viewMode = page.getByRole('radiogroup', { name: '视图模式' });
  await viewMode.getByRole('radio', { name: '列表' }).click();
  await expect(viewMode.getByRole('radio', { name: '列表' })).toBeChecked();
  await expect(viewMode.getByRole('radio', { name: '不可用' })).toBeDisabled();

  const visibleColumns = page.getByRole('toolbar', { name: '可见列' });
  await visibleColumns.getByRole('button', { name: '状态' }).click();
  await expect(visibleColumns.getByRole('button', { name: '状态' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await page.goto('/ui-elements/data');
  const tableMode = page.getByRole('radiogroup', { name: '表格状态' });
  await tableMode.getByRole('radio', { name: '多选' }).click();
  const rows = page.getByRole('grid', { name: 'UI Element 治理状态' }).getByRole('row');
  await rows.nth(1).click();
  await rows.nth(2).click();
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(rows.nth(2)).toHaveAttribute('aria-selected', 'true');

  await tableMode.getByRole('radio', { name: '查看空集合' }).click();
  await expect(page.getByText('当前筛选条件下没有 UI Element。')).toBeVisible();
});

test('Alert、Badge、Card 与 Notification 形成可访问的内部权威面', async ({ page }) => {
  await page.goto('/ui-elements/feedback');
  const staticAlert = page.getByRole('region', { name: '更改已经保存' });
  await expect(staticAlert).toBeVisible();
  await expect(staticAlert).not.toHaveAttribute('role', 'status');
  await expect(staticAlert).not.toHaveAttribute('role', 'alert');
  await expect(page.getByLabel('Badge 语义与外观')).toContainText('成功');
  await expect(page.getByRole('region', { name: '新的基座能力可用' })).toBeVisible();
  await page.getByRole('button', { name: '稍后处理' }).click();
  await expect(page.getByRole('region', { name: '通知已关闭' })).toBeVisible();
  await page.getByRole('button', { name: '恢复通知' }).click();
  await expect(page.getByRole('region', { name: '新的基座能力可用' })).toBeVisible();
  await page.getByRole('button', { name: '关闭通知' }).click();
  await expect(page.getByRole('region', { name: '通知已关闭' })).toBeVisible();
  await page.getByRole('button', { name: 'info', exact: true }).click();
  await expect(page.getByText('项目反馈已入队')).toBeVisible();
  await assertOverlayAccessibility(page);
});

test('危险确认使用 AlertDialog 语义且确认动作真实可执行', async ({ page }) => {
  await page.goto('/ui-elements/overlays?overlay=confirm');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('仅清除当前 UI Elements 中的本地动作状态。');
  await assertOverlayAccessibility(page);
  const trigger = page.getByRole('button', { name: '危险确认' });
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toBeHidden();
  await trigger.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认删除' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '确认删除' })).toBeVisible();
});

test('普通 ConfirmDialog 与危险确认保持独立契约', async ({ page }) => {
  await page.goto('/ui-elements/overlays?overlay=confirm-primary');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('不会写入后端、文件或外部系统。');
  await expect(dialog.getByRole('button', { name: '确认' })).toBeEnabled();
  await assertOverlayAccessibility(page);
  await dialog.getByRole('button', { name: '取消' }).click();
  const trigger = page.getByRole('button', { name: '普通确认' });
  await trigger.click();
  await page.getByRole('alertdialog').getByRole('button', { name: '取消' }).click();
  await expect(trigger).toBeFocused();
});

test('Toast 与 Data 状态可通过确定性 URL 直接验证', async ({ page }) => {
  await page.goto('/ui-elements/feedback?overlay=toast');
  await expect(page.getByText('项目反馈已入队')).toBeVisible();
  await assertOverlayAccessibility(page);

  await page.goto('/ui-elements/data?data=empty');
  await expect(page.getByText('当前筛选条件下没有 UI Element。')).toBeVisible();
});

test('Status 与 Progress 保持对象状态和确定进度语义', async ({ page }) => {
  await page.goto('/ui-elements/status-async');
  const tones = page.getByLabel('StatusPill 语义色');
  await expect(tones).toContainText('默认');
  await expect(tones).toContainText('成功');
  await expect(tones).toContainText('警告');
  await expect(tones).toContainText('危险');
  await expect(tones).toContainText('信息');

  const progress = page.getByRole('progressbar', { name: 'UI Element 契约完成度' });
  await expect(progress).toHaveAttribute('aria-valuemin', '0');
  await expect(progress).toHaveAttribute('aria-valuemax', '100');
  await expect(progress).toHaveAttribute('aria-valuenow', '64');
  await expect(page.locator('.ui-progress-meter').getByText('64%')).toBeVisible();
  await assertOverlayAccessibility(page);
});

test('Tabs 保持 Material 键盘语义并由父 Surface 提供内边距', async ({ page }) => {
  await page.goto('/ui-elements/surfaces');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  const tablist = page.getByRole('tablist', { name: '状态组合 Tabs' });
  const normalTab = tablist.getByRole('tab', { name: '正常' });
  const emptyTab = tablist.getByRole('tab', { name: '空状态' });
  const warningTab = tablist.getByRole('tab', { name: '警告' });

  await expect(normalTab).toHaveAttribute('aria-selected', 'true');
  const inset = await tablist.evaluate((element) => {
    const surface = element.closest('section');
    if (!surface) return null;
    const tablistRect = element.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    return {
      left: tablistRect.left - surfaceRect.left,
      right: surfaceRect.right - tablistRect.right,
      top: tablistRect.top - surfaceRect.top,
    };
  });
  expect(inset).not.toBeNull();
  expect(inset?.left).toBeGreaterThanOrEqual(12);
  expect(inset?.right).toBeGreaterThanOrEqual(12);
  expect(inset?.top).toBeGreaterThanOrEqual(12);

  await normalTab.press('ArrowRight');
  await expect(emptyTab).toBeFocused();
  await expect(emptyTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: '这里还没有内容' })).toBeVisible();
  await emptyTab.press('ArrowRight');
  await expect(warningTab).toBeFocused();
  await expect(warningTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: '部分能力受到限制' })).toBeVisible();
  await assertOverlayAccessibility(page);
});

test('TabsView line、section、soft 与 vertical 视觉职责边界', async ({ page }) => {
  await page.goto('/ui-elements/navigation');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  const colors = await readThemeRoles(page);

  // Showcase：soft / line / line+icon / line+badge / vertical / section
  const tablists = page.getByRole('tablist');
  await expect(tablists).toHaveCount(6);

  // soft：muted surface 容器 + selected elevated surface，无 line underline
  const soft = tablists.nth(0);
  const softListBg = await soft.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(softListBg).toBe(colors.muted);
  await expect(soft.getByRole('tab', { name: '总览' })).toHaveAttribute('aria-selected', 'true');
  const softSelectedBg = await soft
    .getByRole('tab', { name: '总览' })
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(softSelectedBg).toBe(colors.surface);
  // soft selected 无 brand underline indicator（表面可有轻 border，但不是 2px brand 下划线）
  const softSelectedBorderBottom = await soft.getByRole('tab', { name: '总览' }).evaluate((el) => ({
    width: getComputedStyle(el).borderBottomWidth,
    color: getComputedStyle(el).borderBottomColor,
  }));
  expect(softSelectedBorderBottom.width).not.toBe('2px');
  await expect(
    soft.locator('xpath=ancestor::*[@data-ui-tabs][1]').locator('.ui-tabs-indicator'),
  ).toBeHidden();

  // line：透明 TabList、无圆角、底部 1px 基线；无胶囊残留
  const line = tablists.nth(1);
  await expect(line).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(line).toHaveCSS('border-bottom-width', '1px');
  const lineSelected = line.getByRole('tab', { name: '正常' });
  await expect(lineSelected).toHaveAttribute('aria-selected', 'true');
  await expect(lineSelected).toHaveCSS('color', colors.brand);
  const lineRadius = await lineSelected.evaluate((el) => getComputedStyle(el).borderRadius);
  expect(lineRadius).toBe('0px'); // 无胶囊
  const lineUnderline = line
    .locator('xpath=ancestor::*[@data-ui-tabs][1]')
    .locator('.ui-tabs-indicator');
  await expect(lineUnderline).toHaveCSS('height', '2px');
  await expect(lineUnderline).toHaveCSS('background-color', colors.brand);

  // section：透明、无成形 Toolbar、无强制 baseline；selected 仍 brand underline
  const section = tablists.nth(5);
  await expect(section).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(section).toHaveCSS('border-bottom-width', '0px');
  const sectionRadius = await section.evaluate((el) => getComputedStyle(el).borderRadius);
  expect(sectionRadius).toBe('0px');
  await expect(section.getByRole('tab', { name: '正常' })).toHaveAttribute('aria-selected', 'true');

  // vertical：line 语义下 side indicator（border-s）+ foreground，无 bottom underline
  const vertical = tablists.nth(4);
  await expect(vertical).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const verticalSelected = vertical.getByRole('tab', { name: '总览' });
  await expect(verticalSelected).toHaveAttribute('aria-selected', 'true');
  await expect(verticalSelected).toHaveCSS('color', colors.brand);
  const vSide = vertical
    .locator('xpath=ancestor::*[@data-ui-tabs][1]')
    .locator('.ui-tabs-indicator');
  await expect(vSide).toHaveCSS('width', '2px');
  await expect(vSide).toHaveCSS('background-color', colors.brand);
  const vBottom = await verticalSelected.evaluate((el) => getComputedStyle(el).borderBottomWidth);
  expect(vBottom).toBe('0px');
  // vertical ARIA orientation
  await expect(vertical).toHaveAttribute('aria-orientation', 'vertical');

  // icon / badge 不改变 tab 结构：line+icon / line+badge 的 tab 仍可聚焦、语义稳定
  const iconLine = tablists.nth(2);
  await expect(iconLine.getByRole('tab', { name: /通知/ }).locator('svg')).toHaveCount(1);
  const badgeLine = tablists.nth(3);
  await expect(
    badgeLine.getByRole('tab', { name: /通知/ }).locator('span.rounded-full'),
  ).toHaveCount(1);

  // keyboard：line 的 ArrowRight 切换与 aria-selected
  await line.getByRole('tab', { name: '正常' }).press('ArrowRight');
  await expect(line.getByRole('tab', { name: '空状态' })).toHaveAttribute('aria-selected', 'true');

  // vertical keyboard：ArrowDown 切换
  await vertical.getByRole('tab', { name: '总览' }).press('ArrowDown');
  await expect(vertical.getByRole('tab', { name: '通知' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await assertOverlayAccessibility(page);
});

test('section Tabs 宿主组合：TabList 与内容共享父容器 inset 且无第二层 Surface', async ({
  page,
}) => {
  // create-edit 的 section Tabs 位于 Section contentInset 内：
  // TabList 与 TabPanel 内容共享同一 horizontal inset，TabList 不自建背景/Surface。
  await page.goto('/page-archetypes/create-edit');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');

  const tablist = page.getByRole('tablist', { name: '配置步骤' });
  await expect(tablist).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(tablist).toHaveCSS('border-bottom-width', '0px');
  const metrics = await page.evaluate(() => {
    const list = [...document.querySelectorAll('[role="tablist"]')].find(
      (l) => l.getAttribute('aria-label') === '配置步骤',
    );
    const panel = document.querySelector('[role="tabpanel"]');
    if (!list || !panel) return null;
    return {
      listLeft: Math.round(list.getBoundingClientRect().left),
      panelLeft: Math.round(panel.getBoundingClientRect().left),
    };
  });
  expect(metrics).not.toBeNull();
  // TabList 与内容共享父容器 horizontal inset（同一 left 起点，不漂浮左上）
  expect(Math.abs((metrics?.listLeft ?? 0) - (metrics?.panelLeft ?? 0))).toBeLessThanOrEqual(1);
  // 内容区不因 Tabs 出现第二层 Surface：TabPanel 背景透明
  const panelBg = await page
    .locator('[role="tabpanel"]')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(panelBg).toBe('rgba(0, 0, 0, 0)');
});

test('Radio/Checkbox 内部 indicator 与 label 同行且无双重成形', async ({ page }) => {
  await page.goto('/ui-elements/forms');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  const radioPanel = page
    .getByRole('heading', { level: 3, name: 'RadioGroupField' })
    .locator('xpath=ancestor::section[1]');
  const group = radioPanel.getByRole('radiogroup', { name: '反馈密度', exact: true });
  await expect(group.getByRole('radio')).toHaveCount(3);
  for (const radio of await group.getByRole('radio').all()) {
    const geometry = await radio.evaluate((input) => {
      const row = input.closest('label');
      const indicator = input.parentElement?.querySelector('svg');
      const text = row?.querySelector('.ui-choice-text > span:first-child');
      if (!row || !indicator || !text) throw new Error('Radio anatomy missing');
      return {
        controls: row.querySelectorAll('input[type="radio"]').length,
        indicatorTop: indicator.getBoundingClientRect().top,
        textTop: text.getBoundingClientRect().top,
      };
    });
    expect(geometry.controls).toBe(1);
    expect(Math.abs(geometry.indicatorTop - geometry.textTop)).toBeLessThan(8);
  }
  await group.getByRole('radio', { checked: false }).first().press('Space');
  await expect(group.getByRole('radio', { checked: true })).toHaveCount(1);

  const tiles = radioPanel.getByRole('radiogroup', { name: '图标选择卡片', exact: true });
  await expect(tiles.getByRole('radio')).toHaveCount(3);
  for (const radio of await tiles.getByRole('radio').all()) {
    const geometry = await radio.evaluate((input) => {
      const row = input.closest('label');
      const icon = input.parentElement?.querySelector('svg');
      const text = row?.querySelector('.ui-choice-text > span:first-child');
      if (!row || !icon || !text) throw new Error('Choice tile anatomy missing');
      const style = getComputedStyle(icon);
      return {
        icons: row.querySelectorAll('svg').length,
        iconBottom: icon.getBoundingClientRect().bottom,
        labelTop: text.getBoundingClientRect().top,
        background: style.backgroundColor,
        border: style.borderTopWidth,
        width: icon.getBoundingClientRect().width,
        height: icon.getBoundingClientRect().height,
      };
    });
    expect(geometry.icons).toBe(1);
    expect(geometry.iconBottom).toBeLessThanOrEqual(geometry.labelTop);
    expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
    expect(geometry.border).toBe('0px');
    expect(geometry.width).toBe(20);
    expect(geometry.height).toBe(20);
  }
  const checkboxPanel = page
    .getByRole('heading', { level: 3, name: 'CheckboxField' })
    .locator('xpath=ancestor::section[1]');
  const checkbox = checkboxPanel.getByRole('checkbox').first();
  const checkboxGeometry = await checkbox.evaluate((input) => {
    const row = input.closest('label');
    const control = input.parentElement?.querySelector('svg');
    const text = row?.querySelector('span.block');
    if (!row || !control || !text) throw new Error('Checkbox anatomy missing');
    return {
      controls: row.querySelectorAll('input[type="checkbox"]').length,
      controlTop: control.getBoundingClientRect().top,
      textTop: text.getBoundingClientRect().top,
    };
  });
  expect(checkboxGeometry.controls).toBe(1);
  expect(Math.abs(checkboxGeometry.controlTop - checkboxGeometry.textTop)).toBeLessThan(8);
  const selectedRadioColor = await group
    .getByRole('radio', { checked: true })
    .evaluate((input) => getComputedStyle(input.parentElement!).color);
  const selectedCheckboxColor = await checkboxPanel
    .getByRole('checkbox', { checked: true })
    .first()
    .evaluate((input) => getComputedStyle(input.parentElement!).color);
  expect(selectedCheckboxColor).toBe(selectedRadioColor);
});

test('Action 与 ToggleGroup 内部 icon wrapper 不二次成形', async ({ page }) => {
  await page.goto('/ui-elements/actions-selection');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');

  // Action：带 leadingIcon 的主操作按钮，icon wrapper 无 surface、16px、与 label 同行
  const action = page.getByRole('button', { name: '主要操作' });
  const iconWrap = await action
    .locator('span.grid')
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        bg: s.backgroundColor,
        borderW: s.borderTopWidth,
        radius: s.borderRadius,
        shadow: s.boxShadow,
        w: s.width,
        h: s.height,
      };
    });
  expect(iconWrap.bg).toBe('rgba(0, 0, 0, 0)');
  expect(iconWrap.borderW).toBe('0px');
  expect(iconWrap.radius).toBe('0px');
  expect(iconWrap.w).toBe('16px');

  // ToggleGroup：item 唯一成形；icon wrapper transparent / border 0 / shadow none
  const toggleItem = page.getByRole('radio', { name: '网格' });
  await expect(toggleItem).toHaveAttribute('aria-checked', 'true');
  const inner = await toggleItem.evaluate((item) => {
    const wrap = item.querySelector('span.grid');
    if (!(wrap instanceof HTMLElement)) return null;
    const s = getComputedStyle(wrap);
    return {
      bg: s.backgroundColor,
      borderW: s.borderTopWidth,
      radius: s.borderRadius,
      shadow: s.boxShadow,
    };
  });
  expect(inner).not.toBeNull();
  expect(inner?.bg).toBe('rgba(0, 0, 0, 0)');
  expect(inner?.borderW).toBe('0px');
  expect(inner?.shadow).toContain('none');

  // icon wrapper 内 svg 四向 margin = 0（vendor 纵向 margin 被清理，保证与文字共轴）
  const iconSvgMargin = await toggleItem
    .locator('svg')
    .first()
    .evaluate((svg) => getComputedStyle(svg).margin);
  expect(iconSvgMargin).toBe('0px');

  // single：连续 segmented（容器 gap 0，不拆散）
  const singleGroup = page.getByRole('radiogroup', { name: '视图模式' });
  await expect(singleGroup).toHaveCSS('gap', '0px');
  const singleItemRadius = await toggleItem.evaluate((el) => getComputedStyle(el).borderRadius);
  expect(singleItemRadius).not.toBe('0px'); // 保留自身语义 radius（无 attached 裁剪）

  // multiple：每个 item 独立几何 + 语义 gap（可见列）
  const multiGroup = page.getByRole('toolbar', { name: '可见列' });
  await expect(multiGroup).not.toHaveCSS('gap', '0px');
  const multiGeom = await multiGroup.evaluate((group) => {
    const items = [...group.querySelectorAll('button[aria-pressed]')] as HTMLElement[];
    return items.map((it, index) => {
      const cs = getComputedStyle(it);
      const r = it.getBoundingClientRect();
      const prev = items[index - 1];
      const gap = prev
        ? Math.round(
            r.left - (prev.getBoundingClientRect().left + prev.getBoundingClientRect().width),
          )
        : 0;
      return {
        label: (it.textContent || '').trim().slice(0, 6),
        radius: cs.borderRadius,
        borderTop: cs.borderTopWidth,
        borderRight: cs.borderRightWidth,
        borderBottom: cs.borderBottomWidth,
        borderLeft: cs.borderLeftWidth,
        gapToPrev: gap,
      };
    });
  });
  expect(multiGeom.length).toBeGreaterThanOrEqual(2);
  for (const item of multiGeom) {
    // 独立几何：四边 border 完整、radius 完整（无 attached 中间项/首尾裁剪）
    expect(item.borderTop).not.toBe('0px');
    expect(item.borderRight).not.toBe('0px');
    expect(item.borderBottom).not.toBe('0px');
    expect(item.borderLeft).not.toBe('0px');
    expect(item.radius).not.toBe('0px');
  }
  // items 之间有 semantic gap（> 0）
  for (let i = 1; i < multiGeom.length; i += 1) {
    expect(multiGeom[i]?.gapToPrev ?? 0).toBeGreaterThan(0);
  }
});

test('Select 与 Combobox 使用统一 Popup、键盘和选中状态', async ({ page }) => {
  await page.goto('/ui-elements/forms');
  const select = page.getByRole('combobox', { name: 'Select', exact: true, includeHidden: true });
  await select.click();
  const selectListbox = page.getByRole('listbox');
  await expect(selectListbox).toBeVisible();
  await expect(page.getByRole('option', { name: '自动执行' })).toBeDisabled();
  await assertMatchesTriggerWidth(page, select);
  await assertListboxScrolls(page);
  await expect(page.getByRole('option', { name: '执行队列 12' })).toBeVisible();
  await expect.soft(page).toHaveScreenshot('ui-elements-select-open.png');
  await page.keyboard.press('Enter');
  await expect(select).toContainText('执行队列 12');

  const combo = page.getByRole('combobox', { name: 'Combobox' });
  await combo.click();
  await expect(page.getByRole('option', { name: 'Omar Haddad' })).toBeDisabled();
  await assertMatchesTriggerWidth(page, combo);
  await assertListboxScrolls(page);

  // 组合框保留单一文本输入和 label，MUI 的外层容器负责边框。
  await expect(combo).toHaveAccessibleName('Combobox');
  await expect(combo.locator('xpath=ancestor::label')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await combo.click();
  await combo.fill('Mika');
  await expect(page.getByRole('option', { name: 'Mika Sato' })).toBeVisible();
  await assertMatchesTriggerWidth(page, combo);
  await expect.soft(page).toHaveScreenshot('ui-elements-combobox-open.png');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(combo).toHaveValue('Mika Sato');
  await assertOverlayAccessibility(page);
});

test('Dropdown、Popover 与 Tooltip 展开面进入视觉回归', async ({ page }) => {
  await page.goto('/ui-elements/overlays');
  const menuTrigger = page.getByRole('button', { name: 'Reference 操作菜单' });
  await menuTrigger.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect.soft(page).toHaveScreenshot('ui-elements-menu-open.png');
  await page.keyboard.press('Escape');
  await expect(menuTrigger).toBeFocused();

  const popoverTrigger = page.getByRole('button', { name: 'Popover', includeHidden: true });
  const pageHeightBeforeOpen = await page
    .locator('html')
    .evaluate((element) => element.scrollHeight);
  await popoverTrigger.click();
  const popover = page.getByRole('dialog', { name: '组合提示' });
  await expect(popover).toBeVisible();
  // The reference grows as capabilities are added; collision handling may flip the overlay above.
  await expect
    .poll(async () => {
      const anchor = await popoverTrigger.evaluate((element) => {
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return { left, right, top, bottom };
      });
      const overlay = await popover.evaluate((element) => {
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return { left, right, top, bottom };
      });
      const viewport = page.viewportSize();
      return (
        viewport !== null &&
        overlay.left >= 0 &&
        overlay.right <= viewport.width &&
        overlay.top >= 0 &&
        overlay.bottom <= viewport.height &&
        (overlay.top >= anchor.bottom || overlay.bottom <= anchor.top)
      );
    })
    .toBe(true);
  await expect(popover).toBeFocused();
  const pageHeightAfterOpen = await page
    .locator('html')
    .evaluate((element) => element.scrollHeight);
  expect(pageHeightAfterOpen).toBe(pageHeightBeforeOpen);
  await expect.soft(page).toHaveScreenshot('ui-elements-popover-open.png');
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(popoverTrigger).toBeFocused();

  const tooltipTrigger = page.getByRole('button', { name: '键盘聚焦与悬停均可访问', exact: true });
  await tooltipTrigger.scrollIntoViewIfNeeded();
  await waitForVisualReadiness(page);
  await tooltipTrigger.focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await waitForVisualReadiness(page);
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect.soft(page).toHaveScreenshot('ui-elements-tooltip-open.png');
});

test('DatePicker 与 Command 展开面支持键盘及无障碍扫描', async ({ page }, info) => {
  // Keep the calendar's today marker stable while timers and interactions keep running.
  await page.clock.setFixedTime(new Date('2026-10-09T04:00:00Z'));
  await page.goto('/ui-elements/forms');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  const datePickerTrigger = page
    .getByRole('group', { name: 'DatePicker', exact: true })
    .getByRole('button', { name: '选择复核日期' });
  // Focus entry stabilizes the project's Reveal before measuring the offscreen anchor.
  await datePickerTrigger.focus();
  // 触发元素位于首屏之外：先滚动进入视口再点击，避免打开弹层时的滚动定位竞态
  // （页面转场组件加入后，点击视口外触发器会偶发改变锚点测量结果）
  await datePickerTrigger.evaluate((element) =>
    element.scrollIntoView({ behavior: 'instant', block: 'center' }),
  );
  await datePickerTrigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('grid')).toBeVisible();
  const roles = await readThemeRoles(page);
  await expect(
    page.getByRole('group', { name: 'DatePicker', exact: true }).locator('fieldset'),
  ).toHaveCSS('border-color', roles.brand);
  await waitForVisualReadiness(page);
  await assertOverlayAccessibility(page);
  await expect.soft(page).toHaveScreenshot('ui-elements-date-picker-open.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await waitForVisualReadiness(page);
  await assertOverlayAccessibility(page);
  await page.screenshot({ path: info.outputPath('calendar-dark.png'), animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press('Escape');

  await page.goto('/ui-elements/overlays');
  await page.getByRole('button', { name: 'Command' }).click();
  const commandDialog = page.getByRole('dialog');
  await expect(commandDialog).toContainText('快速跳转');
  await expect(commandDialog.getByRole('combobox', { name: '搜索命令' })).toHaveCount(1);
  await page.getByLabel('搜索命令').fill('状态');
  await expect(page.getByRole('option', { name: /状态体系/ })).toBeInViewport({ ratio: 1 });
  await assertOverlayAccessibility(page);
  await expect.soft(page).toHaveScreenshot('ui-elements-command-open.png');
});

test('Dialog 与 Drawer 锁定焦点并支持 Escape 恢复 Trigger', async ({ page }) => {
  await page.goto('/ui-elements/overlays');
  const dialogTrigger = page.getByRole('button', { name: 'Dialog' });
  await dialogTrigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await waitForVisualReadiness(page);
  await expect.soft(page).toHaveScreenshot('ui-elements-dialog-open.png');
  await page.keyboard.press('Escape');
  await expect(dialogTrigger).toBeFocused();

  const drawerTrigger = page.getByRole('button', { name: 'Drawer' });
  await drawerTrigger.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('辅助配置');
  await assertOverlayAccessibility(page);
  await expect.soft(page).toHaveScreenshot('ui-elements-drawer-open.png');
  await page.keyboard.press('Escape');
  await expect(drawerTrigger).toBeFocused();
});

test('Overlay Trigger 交互状态不切换成 Brand Primary（idle/hover/pressed/focus-restored）', async ({
  page,
}) => {
  await page.goto('/ui-elements/overlays');
  const colors = await readThemeRoles(page);

  // 五类 trigger 的语义断言：底层必须是 ghost variant，绝不带 button--primary
  const triggerNames = ['Dialog', '普通确认', '危险确认', 'Drawer', 'Command'] as const;
  for (const name of triggerNames) {
    const trigger = page.getByRole('button', { name, exact: true });
    await expect(trigger).toBeVisible();
    const cls = (await trigger.getAttribute('class')) ?? '';
    expect(cls).toContain('ui-overlay-trigger');
    expect(cls).not.toContain('button--primary');
    // Material outlined 使用 primary 前景与透明容器；危险入口保持 danger 语义。
    if (name === '危险确认') {
      expect(cls).toContain('text-danger');
    } else {
      await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(trigger).toHaveCSS('color', colors.ink);
      await expect(trigger).toHaveCSS('border-top-width', '1px');
    }
  }

  // Dialog 的容器在 pressed 与焦点恢复后只使用透明或 surface-muted 状态层。
  const dialogTrigger = page.getByRole('button', { name: 'Dialog', exact: true });
  await dialogTrigger.scrollIntoViewIfNeeded();
  await waitForVisualReadiness(page);
  const readBg = () =>
    dialogTrigger.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        bg: cs.backgroundColor,
        cls: (el.getAttribute('class') ?? '').split(' ').filter((c) => c.includes('button--')),
      };
    });

  const idle = await readBg();
  expect(idle.bg).toBe('rgba(0, 0, 0, 0)');

  // pressed：mouse down 不释放，背景不得变 accent 蓝（保持中性或 muted 反馈）
  const box = (await dialogTrigger.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 15);
  await page.mouse.down();
  await expect.poll(async () => (await readBg()).bg).toBe(colors.muted);
  const pressed = await readBg();
  // 允许中性按下反馈；普通展开动作保持中性语义。
  expect(pressed.cls).not.toContain('button--primary');
  await page.mouse.up();

  // 打开 Dialog 再 Escape 关闭（focus restore 到 trigger）：背景仍中性，无蓝色残留
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialogTrigger).toBeFocused();
  await page.waitForTimeout(200);
  const restored = await readBg();
  expect(restored.cls).not.toContain('button--primary');
  await expect.poll(async () => [idle.bg, colors.muted].includes((await readBg()).bg)).toBe(true);
});

test('危险确认 Trigger 在 pressed 状态保持 danger 语义（不切换 Brand）', async ({ page }) => {
  await page.goto('/ui-elements/overlays?overlay=confirm');
  const trigger = page.getByRole('button', { name: '危险确认', exact: true, includeHidden: true });
  // 关闭默认打开的 dialog 以便操作 trigger（与既有用例一致：用取消按钮关闭）
  await page.getByRole('alertdialog').getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('alertdialog')).toBeHidden();

  const readState = () =>
    trigger.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        bg: cs.backgroundColor,
        color: cs.color,
        cls: (el.getAttribute('class') ?? '').split(' '),
      };
    });

  const idle = await readState();
  const idleCls = idle.cls.join(' ');
  expect(idleCls).toContain('text-danger');
  expect(idleCls).not.toContain('button--primary');

  // pressed：背景变 danger-soft（danger 语义反馈），不出现 brand 蓝
  const box = (await trigger.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 15);
  await page.mouse.down();
  await page.waitForTimeout(120);
  const pressedCls = (await readState()).cls.join(' ');
  expect(pressedCls).toContain('ui-overlay-trigger-danger');
  const pressedColor = (await readState()).color;
  expect(pressedColor).toBe(idle.color);
  expect(pressedCls).not.toContain('button--primary');
  expect(pressedCls).not.toContain('data-[pressed=true]:bg-brand');
  await page.mouse.up();
});

test('Tree 层级数据集合：depth 缩进、展开/折叠、状态与 keyboard 语义', async ({ page }) => {
  await page.goto('/ui-elements/navigation');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  const tree = page.getByRole('treegrid', { name: '基座树' });

  // Tree 自身轻量透明（Surface 由宿主提供）
  await expect(tree).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(tree).toHaveCSS('border-top-width', '0px');

  // depth 缩进：level 2 内容起点 > level 1 内容起点（稳定 semantic 步进）
  const indents = await tree.evaluate((el) => {
    const rows = [...el.querySelectorAll('[role="row"]')];
    return rows.map((r) => {
      const content = r.querySelector('.ui-tree-row');
      const cs = content ? getComputedStyle(content) : null;
      return {
        level: Number(r.getAttribute('aria-level')),
        padStart: cs ? Number.parseFloat(cs.paddingInlineStart) : 0,
        disabled: r.getAttribute('aria-disabled') === 'true',
        hasChevron: !!r.querySelector('button[slot="chevron"]'),
        hasFakeLeaf: (
          r.querySelector(':scope > .ui-tree-row > span.grid.size-5')?.textContent ?? ''
        ).includes('•'),
      };
    });
  });
  const level1Pad = indents.find((i) => i.level === 1)?.padStart ?? 0;
  const level2Pad = indents.find((i) => i.level === 2)?.padStart ?? 0;
  expect(level2Pad).toBeGreaterThan(level1Pad); // 层级缩进生效
  // 叶子不渲染假 affordance（•）
  expect(indents.some((i) => i.hasFakeLeaf)).toBe(false);

  // disabled 行保持结构且降权（aria-disabled + 可见但不可选中）
  await expect(tree.getByRole('row', { name: 'Motion' })).toHaveAttribute('aria-disabled', 'true');

  // 展开/折叠：焦点父行 chevron，Enter 收起，ArrowRight 重新展开
  const parentRow = tree.getByRole('row', { name: 'Universal Foundation' });
  await expect(parentRow).toHaveAttribute('aria-expanded', 'true');
  const chevron = parentRow.getByRole('button', { name: '收起 Universal Foundation' });
  await chevron.focus();
  await page.keyboard.press('Enter');
  await expect(parentRow).toHaveAttribute('aria-expanded', 'false');
  await expect(tree.getByRole('row', { name: 'UI Elements' })).toHaveCount(0);
  await parentRow.focus();
  await page.keyboard.press('ArrowRight');
  await expect(parentRow).toHaveAttribute('aria-expanded', 'true');
  await expect(tree.getByRole('row', { name: 'UI Elements' })).toHaveCount(1);

  // 键盘行导航：ArrowDown 沿可见行移动（RAC treegrid 语义）
  await parentRow.focus();
  await expect(parentRow).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('row', { name: 'UI Elements' })).toBeFocused();

  // Axe WCAG AA（treegrid 内）
  const accessibility = await new AxeBuilder({ page })
    .include('[aria-label="基座树"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test('受控外部触发器、底部面板与全屏复用 Material 浮层契约', async ({ page }) => {
  for (const kind of ['external-popover', 'bottom-sheet', 'fullscreen']) {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/ui-elements/overlays?overlay=' + kind);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    if (kind === 'bottom-sheet') {
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBe(0);
      expect(Math.round(bounds!.y + bounds!.height)).toBe(800);
    }
    if (kind === 'fullscreen') {
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBe(0);
      expect(bounds!.y).toBe(0);
      expect(bounds!.width).toBe(320);
      expect(bounds!.height).toBe(800);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
});
