import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';

export const pluginDefinition = {
  pluginId: 'reference-resources',
  mount: '/reference-resources',
} as const satisfies PluginDefinition;
