import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';

export const pluginDefinition = {
  pluginId: 'states',
  mount: '/states',
} as const satisfies PluginDefinition;
