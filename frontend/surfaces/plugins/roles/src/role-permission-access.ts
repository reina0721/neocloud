import type { DirectoryRole, IdentityAccess } from '@neocloud/surface/identity/runtime';

export function canEditNativeRolePermissions(access: IdentityAccess, role: DirectoryRole) {
  return (
    !role.protected &&
    ['iam:role:read', 'iam:role:write', 'iam:permission:read'].every((permission) =>
      access.nativePermissions?.includes(permission),
    )
  );
}
