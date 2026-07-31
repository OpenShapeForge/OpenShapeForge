// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import type {
  RendererFieldConfig,
  RendererFieldDisplayMode,
} from "@/features/renderer/form-definition";
import { hasRendererFieldWriteAccess } from "./permissions";
import { isRendererFieldVisible } from "./visibility";

export function isRendererFieldReadOnly(
  field: Field,
  mode: "create" | "edit" | "review" | "display",
  grantedPermissions?: readonly string[],
) {
  if (mode === "display") {
    return true;
  }

  if (!hasRendererFieldWriteAccess(field, grantedPermissions)) {
    return true;
  }

  return Boolean(field.readOnly || field.computed);
}

export function resolveRendererFieldDisplayMode(
  field: Field,
  fieldConfig: RendererFieldConfig | undefined,
  mode: "create" | "edit" | "review" | "display",
  rootValues: Record<string, unknown>,
  grantedPermissions?: readonly string[],
  visibilityScope?: Record<string, unknown> | null,
): RendererFieldDisplayMode {
  if (!isRendererFieldVisible(field, rootValues, grantedPermissions, visibilityScope)) {
    return "hidden";
  }

  if (fieldConfig?.displayMode === "hidden") {
    return "hidden";
  }

  if (fieldConfig?.displayMode === "masked") {
    return "masked";
  }

  if (mode === "display") {
    return fieldConfig?.displayMode === "readOnly" ? "readOnly" : "display";
  }

  if (
    fieldConfig?.displayMode === "display" ||
    fieldConfig?.displayMode === "readOnly"
  ) {
    return fieldConfig.displayMode;
  }

  if (isRendererFieldReadOnly(field, mode, grantedPermissions)) {
    return "readOnly";
  }

  return "edit";
}
