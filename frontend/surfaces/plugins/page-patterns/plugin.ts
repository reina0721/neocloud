import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';

export const pluginDefinition = {
  pluginId: 'page-patterns',
  mount: '/page-patterns',
} as const satisfies PluginDefinition;
