import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';
export const pluginDefinition = {
  pluginId: 'notifications',
  mount: '/notifications',
} as const satisfies PluginDefinition;
