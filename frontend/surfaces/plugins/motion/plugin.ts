import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';

export const pluginDefinition = {
  pluginId: 'motion',
  mount: '/motion',
} as const satisfies PluginDefinition;
