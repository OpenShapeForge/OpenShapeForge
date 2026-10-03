// SPDX-License-Identifier: BUSL-1.1
/** Storage-value protection, retaining object members and collection items. */
export const FIELD_ITEM_ID = "__osfItemId";

export type FieldValuePolicy = {
  /** Compiler-managed identity of protected object collection items. */
  itemKey?: string;
  /** Complete value contract, checked after protected object patches are merged. */
  valueSchema?: Record<string, unknown>;
  classification?: "confidential" | "pii" | "bsn";
  immutable?: true;
  writtenBy?: string[];
  readRoles?: string[];
  writeRoles?: string[];
  children?: Record<string, FieldValuePolicy>;
  item?: FieldValuePolicy;
};
