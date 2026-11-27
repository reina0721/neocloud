import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';

export const pluginDefinition = {
  pluginId: 'workspace',
  mount: '/workspace',
} as const satisfies PluginDefinition;
