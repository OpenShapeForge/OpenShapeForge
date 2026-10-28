// SPDX-License-Identifier: BUSL-1.1
/** Generic entity principal classes, shared by compilation and layer composition. */
export const PRINCIPAL_CLASSES = ["application", "person", "service", "unknown"] as const;
export const RECORD_ACTION_DEFAULT_PRINCIPAL_CLASSES = PRINCIPAL_CLASSES.filter((kind) => kind !== "application");
