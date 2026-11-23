import {
  inventoryPageSchema,
  inventoryItemSchema,
  adminTaskListSchema,
  adminTaskSummarySchema,
  adminTaskSchema,
  adminTaskPageSchema,
  adminTaskCleanupSchema,
  workerNodeCatalogSchema,
  workerNodeCheckSchema,
  adminSharePageSchema,
  adminShareItemSchema,
  adminShareRevokeSchema,
  blobPageSchema,
  blobDetailSchema,
  blobCandidatePageSchema,
  filesystemSettingsSchema,
  fileIconRulesViewSchema,
  activeFileIconsSchema,
  fileApplicationViewSchema,
  fileApplicationPolicySchema,
  webFilePreviewSchema,
  wopiDiscoverySchema,
  storagePolicySchema,
  storageUsageSchema,
  storageNameRulesViewSchema,
  storageNameRuleCheckSchema,
  propertyDefinitionsViewSchema,
  type FilesPort,
} from '@clouddrive/surface/files';
import type { createJsonClient } from '../api/json-client';

type FileAdministration = Pick<
  FilesPort,
  | 'listInventory'
  | 'readInventory'
  | 'listAdminTasks'
  | 'readAdminTaskSummary'
  | 'readAdminTask'
  | 'previewAdminTaskCleanup'
  | 'cleanAdminTasks'
  | 'listWorkerNodes'
  | 'checkWorkerNode'
  | 'listAdminShares'
  | 'readAdminShare'
  | 'revokeAdminShares'
  | 'listBlobs'
  | 'readBlob'
  | 'listBlobCandidates'
  | 'reclaimBlob'
  | 'readFilesystemSettings'
  | 'readFileIconRules'
  | 'saveFileIconRules'
  | 'readActiveFileIcons'
  | 'readFileApplications'
  | 'saveFileApplications'
  | 'readActiveFileApplications'
  | 'launchWebFilePreview'
  | 'discoverWOPI'
  | 'readStoragePolicy'
  | 'saveStoragePolicy'
  | 'readStorageUsage'
  | 'readStorageNameRules'
  | 'saveStorageNameRules'
  | 'checkStorageNameRules'
  | 'saveFilesystemSettings'
  | 'readPropertyDefinitions'
  | 'savePropertyDefinitions'
>;

/** 库存、维护和文件策略复用 Host 的账号绑定传输。 */
export function createFileAdministration(
  call: ReturnType<typeof createJsonClient>,
): FileAdministration {
  return {
    listInventory: async (query, signal) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== '' && value !== false) params.set(key, String(value));
      }
      return inventoryPageSchema.parse(await call('/inventory?' + params.toString(), { signal }));
    },
    readInventory: async (id, signal) =>
      inventoryItemSchema.parse(await call('/inventory/' + encodeURIComponent(id), { signal })),
    listAdminTasks: async (query, signal) => {
      const params = new URLSearchParams({ ...query, page: String(query.page) });
      return adminTaskListSchema.parse(await call('/admin-tasks?' + params.toString(), { signal }));
    },
    readAdminTaskSummary: async (query, signal) =>
      adminTaskSummarySchema.parse(
        await call('/admin-tasks/summary?' + new URLSearchParams(query).toString(), { signal }),
      ),
    readAdminTask: async (kind, id, signal) =>
      adminTaskSchema.parse(
        await call(`/admin-tasks/${kind}/${encodeURIComponent(id)}`, { signal }),
      ),
    previewAdminTaskCleanup: async (query, signal) =>
      adminTaskPageSchema.parse(
        await call('/admin-tasks/cleanup-preview?' + new URLSearchParams(query).toString(), {
          signal,
        }),
      ),
    cleanAdminTasks: async (targets) =>
      adminTaskCleanupSchema.parse(
        await call('/admin-tasks/cleanup', { method: 'POST', body: { targets } }),
      ),
    listWorkerNodes: async (signal) =>
      workerNodeCatalogSchema.parse(await call('/worker-nodes', { signal })),
    checkWorkerNode: async (id, signal) =>
      workerNodeCheckSchema.parse(
        await call('/worker-nodes/' + encodeURIComponent(id) + '/check', { signal }),
      ),
    listAdminShares: async (query, signal) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== '') params.set(key, String(value));
      }
      return adminSharePageSchema.parse(
        await call('/admin-shares?' + params.toString(), { signal }),
      );
    },
    readAdminShare: async (id, signal) =>
      adminShareItemSchema.parse(await call('/admin-shares/' + encodeURIComponent(id), { signal })),
    revokeAdminShares: async (targets) =>
      adminShareRevokeSchema.parse(
        await call('/admin-shares/revoke', { method: 'POST', body: { targets } }),
      ).revoked,
    listBlobs: async (query, signal) => {
      const params = new URLSearchParams({ ...query, page: String(query.page) });
      return blobPageSchema.parse(await call('/blobs?' + params.toString(), { signal }));
    },
    readBlob: async (id, page, signal) =>
      blobDetailSchema.parse(
        await call('/blobs/' + encodeURIComponent(id) + '?page=' + page, { signal }),
      ),
    listBlobCandidates: async (page, signal) =>
      blobCandidatePageSchema.parse(await call('/blob-reclamation?page=' + page, { signal })),
    reclaimBlob: async (id) => {
      await call('/blob-reclamation/' + encodeURIComponent(id), { method: 'POST' });
    },
    readFilesystemSettings: async (signal) =>
      filesystemSettingsSchema.parse(await call('/settings', { signal })),
    readFileIconRules: async (signal) =>
      fileIconRulesViewSchema.parse(await call('/icon-rules', { signal })),
    saveFileIconRules: async (body) =>
      fileIconRulesViewSchema.parse(await call('/icon-rules', { method: 'PUT', body })),
    readActiveFileIcons: async (signal) =>
      activeFileIconsSchema.parse(await call('/icon-rules/active', { signal })).items,
    readFileApplications: async (signal) =>
      fileApplicationViewSchema.parse(await call('/applications', { signal })),
    saveFileApplications: async (body) =>
      fileApplicationViewSchema.parse(await call('/applications', { method: 'PUT', body })),
    readActiveFileApplications: async (signal) =>
      fileApplicationPolicySchema.parse(await call('/applications/active', { signal })),
    launchWebFilePreview: async (entry, application, signal, mode) =>
      webFilePreviewSchema.parse(
        await call('/' + encodeURIComponent(entry.id) + '/web-preview', {
          method: 'POST',
          body: {
            application: application.id,
            origin: application.origin,
            contentRevision: entry.contentRevision,
            ...(mode ? { mode } : {}),
          },
          signal,
        }),
      ),
    discoverWOPI: async (endpoint, signal) =>
      wopiDiscoverySchema.parse(
        await call('/applications/wopi-discovery', { method: 'POST', body: { endpoint }, signal }),
      ),
    readStoragePolicy: async (signal) =>
      storagePolicySchema.parse(await call('/storage-policy', { signal })),
    saveStoragePolicy: async (body) =>
      storagePolicySchema.parse(await call('/storage-policy', { method: 'PUT', body })),
    readStorageUsage: async (signal) =>
      storageUsageSchema.parse(await call('/storage-policy/usage', { signal })),
    readStorageNameRules: async (signal) =>
      storageNameRulesViewSchema.parse(await call('/storage-policy/name-rules', { signal })),
    saveStorageNameRules: async (body) =>
      storageNameRulesViewSchema.parse(
        await call('/storage-policy/name-rules', { method: 'PUT', body }),
      ),
    checkStorageNameRules: async (name, rules, signal) =>
      storageNameRuleCheckSchema.parse(
        await call('/storage-policy/name-rules/check', {
          method: 'POST',
          body: { name, rules },
          signal,
        }),
      ),
    saveFilesystemSettings: async (body) =>
      filesystemSettingsSchema.parse(await call('/settings', { method: 'PUT', body })),
    readPropertyDefinitions: async (signal) =>
      propertyDefinitionsViewSchema.parse(await call('/property-definitions', { signal })),
    savePropertyDefinitions: async (body) =>
      propertyDefinitionsViewSchema.parse(
        await call('/property-definitions', { method: 'PUT', body }),
      ),
  };
}
