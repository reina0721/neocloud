import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';
export const pluginDefinition = {
  pluginId: 'files',
  mount: '/home',
} as const satisfies PluginDefinition;
