import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';

export const pluginDefinition = {
  pluginId: 'ui-elements',
  mount: '/ui-elements',
} as const satisfies PluginDefinition;
