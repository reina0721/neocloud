import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';

export const pluginDefinition = {
  pluginId: 'departments',
  mount: '/system/departments',
} as const satisfies PluginDefinition;
