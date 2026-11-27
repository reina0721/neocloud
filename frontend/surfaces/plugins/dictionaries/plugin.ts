import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';

export const pluginDefinition = {
  pluginId: 'dictionaries',
  mount: '/system/dictionaries',
} as const satisfies PluginDefinition;
