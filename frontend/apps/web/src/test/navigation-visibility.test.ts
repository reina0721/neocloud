import { describe, expect, it } from 'vitest';
import { generatedRouteCatalog } from '@clouddrive/surface/generated/catalog';
import type { NavigationGroup, NavigationNode } from '@clouddrive/types';
import { visibleProductNavigation } from '../shell/navigation-visibility';
import type { NavigationOverrides } from '../state/use-navigation-admin-store';

const ids = [
  'overview',
  'workspace.root',
  'system-tools.shares',
  'system-tools.tasks',
  'system-tools.nodes',
  'system-tools.storage',
  'system-tools.runtime',
  'system-tools.update',
  'files.root',
] as const;
const entry = (id: string): NavigationNode => ({ kind: 'leaf', id, labelKey: id, href: '/' + id });
const groups: NavigationGroup[] = [
  {
    id: 'administration',
    labelKey: 'group',
    items: [entry(ids[0]), ...ids.slice(1).map(entry)],
  },
];
const result = (native: string[] = [], overrides = {}) =>
  visibleProductNavigation(groups, overrides, true, [], native).flatMap((group) =>
    group.items.map((item) => item.id),
  );

describe('管理导航只呈现当前允许的入口', () => {
  it('文件读取不隐含分享、任务、节点或存储管理权限，管理概览不要求待办权限', () => {
    expect(result(['files:read'])).toEqual(['workspace.root', 'files.root']);
    for (const [permission, id] of [
      ['files:share-admin:read', 'system-tools.shares'],
      ['files:task-admin:read', 'system-tools.tasks'],
      ['files:node:read', 'system-tools.nodes'],
      ['files:storage-policy:read', 'system-tools.storage'],
    ] as const) {
      expect(result([permission])).toEqual(['workspace.root', id]);
    }
  });
  it('菜单覆盖的隐藏、权限与顺序保留，失败或未有权限不放行管理项', () => {
    expect(
      result(['files:node:read'], { 'system-tools.nodes': { hidden: true, version: 1 } }),
    ).toEqual(['workspace.root']);
    expect(
      result(['files:read'], {
        'system-tools.nodes': { permission: 'files:read', version: 1, order: -1 },
      }),
    ).toEqual(['system-tools.nodes', 'workspace.root', 'files.root']);
    expect(result()).toEqual(['workspace.root']);
  });
  it('系统更新和运行状态共用管理读取权限，并注册为正式管理路由', () => {
    expect(result(['management:read'])).toEqual([
      'workspace.root',
      'system-tools.runtime',
      'system-tools.update',
    ]);
    const assignment = generatedRouteCatalog.contributions
      .find(({ pluginId }) => pluginId === 'system-tools')
      ?.contribution.parents.find(({ navigationId }) => navigationId === 'system-tools.update');
    expect(assignment).toMatchObject({
      groupId: 'administration',
      labelKey: 'systemTools.nav.update',
      routeId: 'system-tools.update',
    });
  });
  it('模拟 Host 保留原概览，隐藏需要真实后台的文件管理项', () => {
    const visible = visibleProductNavigation(groups, {}, false, [], []).flatMap((group) =>
      group.items.map((item) => item.id),
    );
    expect(visible).toEqual(['overview', 'workspace.root']);
  });
  it('真实后台默认隐藏开发与模板演示分组，模拟模式仍可见', () => {
    const withDev: NavigationGroup[] = [
      ...groups,
      {
        id: 'development',
        labelKey: 'nav.group.development',
        items: [entry('playground.root')],
      },
    ];
    const prodGroupIds = visibleProductNavigation(withDev, {}, true, [], []).map((g) => g.id);
    const mockGroupIds = visibleProductNavigation(withDev, {}, false, [], []).map((g) => g.id);
    expect(prodGroupIds).not.toContain('development');
    expect(mockGroupIds).toContain('development');
  });

  it('API 工作台的正式入口仍由读取权限和菜单覆写控制', () => {
    const assignment = generatedRouteCatalog.contributions.find(
      ({ pluginId }) => pluginId === 'api-workbench',
    )?.contribution.parents[0];
    expect(assignment).toMatchObject({
      groupId: 'administration',
      navigationId: 'api-workbench.root',
      order: 52,
      routeId: 'api-workbench',
    });
    const groups: NavigationGroup[] = [
      { id: 'administration', labelKey: 'administration', items: [entry('api-workbench.root')] },
      { id: 'management', labelKey: 'management', items: [entry('users.root')] },
    ];
    const permission = 'console:workbench:read';
    const visibleGroups = (native: string[], overrides: NavigationOverrides = {}) =>
      visibleProductNavigation(groups, overrides, true, [], native);
    expect(visibleGroups([])).toEqual([]);
    expect(visibleGroups([permission])).toEqual([groups[0]]);
    expect(
      visibleGroups([permission], { 'api-workbench.root': { hidden: true, version: 1 } }),
    ).toEqual([]);
    expect(
      visibleGroups([permission], {
        'api-workbench.root': { parentId: 'group:management', version: 1 },
      }),
    ).toEqual([{ ...groups[1], items: [entry('api-workbench.root')] }]);
  });

  it('仅当用户目录可见时收起默认账户管理入口，保留显式策略', () => {
    const groups: NavigationGroup[] = [
      { id: 'management', labelKey: 'management', items: [entry('users.root')] },
      { id: 'administration', labelKey: 'administration', items: [entry('users.administration')] },
    ];
    const visibleIds = (permissions: string[], overrides: NavigationOverrides = {}) =>
      visibleProductNavigation(groups, overrides, true, permissions, ['iam:account:write']).flatMap(
        (group) => group.items.map((item) => item.id),
      );
    const defaults = { 'users.administration': { version: 0, order: 45 } };
    expect(visibleIds(['users.read'], defaults)).toEqual(['users.root']);
    expect(visibleIds([], defaults)).toEqual(['users.administration']);
    expect(visibleIds(['users.read'], { 'users.root': { hidden: true, version: 1 } })).toEqual([
      'users.administration',
    ]);
    expect(
      visibleIds(['users.read'], { 'users.administration': { label: '账户安全', version: 1 } }),
    ).toEqual(['users.root', 'users.administration']);
    expect(
      visibleIds(['users.read'], { 'users.administration': { hidden: true, version: 1 } }),
    ).toEqual(['users.root']);
  });
});
