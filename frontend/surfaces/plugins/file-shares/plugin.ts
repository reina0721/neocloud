import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';
export const pluginDefinition = {
  pluginId: 'file-shares',
  mount: '/share',
} as const satisfies PluginDefinition;
