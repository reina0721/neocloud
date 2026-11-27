import type { PluginDefinition } from '@neocloud/plugin-framework/plugin';
export const pluginDefinition = {
  pluginId: 'audit',
  mount: '/audit-logs',
} as const satisfies PluginDefinition;
