import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';

export const pluginDefinition = {
  pluginId: 'menus',
  mount: '/system/menus',
} as const satisfies PluginDefinition;
