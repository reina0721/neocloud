import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';

export const pluginDefinition = {
  pluginId: 'analytics',
  mount: '/analytics',
} as const satisfies PluginDefinition;
