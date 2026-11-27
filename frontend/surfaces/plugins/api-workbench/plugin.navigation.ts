import type { NavigationContribution } from '@neocloud/plugin-framework/navigation';

export const navigationContribution = {
  parents: [
    {
      navigationId: 'api-workbench.root',
      labelKey: 'apiWorkbench.nav.title',
      groupId: 'administration',
      order: 52,
      iconId: 'api',
      routeId: 'api-workbench',
    },
  ],
} as const satisfies NavigationContribution;
