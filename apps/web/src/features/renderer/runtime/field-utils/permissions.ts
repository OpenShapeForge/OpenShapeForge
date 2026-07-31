// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";

function hasMatchingPermission(
  requiredPermissions: readonly string[] | undefined,
  grantedPermissions: readonly string[] | undefined,
) {
  if (!requiredPermissions) {
    return true;
  }

  if (grantedPermissions === undefined) {
    return true;
  }

  if (requiredPermissions.length === 0) {
    return false;
  }

  if (!grantedPermissions || grantedPermissions.length === 0) {
    return false;
  }

  return requiredPermissions.some((permission) =>
    grantedPermissions.includes(permission),
  );
}

export function hasRendererFieldReadAccess(
  field: Field,
  grantedPermissions?: readonly string[],
) {
  return hasMatchingPermission(field.permissions?.read, grantedPermissions);
}

export function hasRendererFieldWriteAccess(
  field: Field,
  grantedPermissions?: readonly string[],
) {
  return hasMatchingPermission(field.permissions?.write, grantedPermissions);
}
