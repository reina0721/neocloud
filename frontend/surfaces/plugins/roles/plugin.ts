import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';
export const pluginDefinition = {
  pluginId: 'roles',
  mount: '/roles',
} as const satisfies PluginDefinition;
