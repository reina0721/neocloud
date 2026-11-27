import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';
export const pluginDefinition = {
  pluginId: 'account',
  mount: '/account',
} as const satisfies PluginDefinition;
