import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';

export const pluginDefinition = {
  pluginId: 'foundations',
  mount: '/foundations',
} as const satisfies PluginDefinition;
