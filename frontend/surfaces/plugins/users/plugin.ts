import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';
export const pluginDefinition = {
  pluginId: 'users',
  mount: '/users',
} as const satisfies PluginDefinition;
