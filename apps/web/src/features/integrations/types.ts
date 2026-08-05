// SPDX-License-Identifier: BUSL-1.1
/**
 * The connector catalog as this page consumes it.
 *
 * Mirrors the `Connector` GraphQL type in
 * `apps/api/src/connectors/graphql-schema.ts`. Hand-written rather than
 * generated because the catalog types are STATIC — they describe connectors,
 * they are not emitted per connector — so this file does not grow when a
 * contract is added. That is the same property the page depends on: a new
 * connector changes `configFields` at runtime, never the code that renders it.
 */
import type { FieldRender, FieldValidation } from "@/generated/compiler/field-contract";

export type LocalizedText = Record<string, string>;

export type ConnectorStatus =
  | "AVAILABLE"
  | "NOT_LICENSED"
  | "NOT_INSTALLED"
  | "NOT_CONFIGURED"
  | "DISABLED";

export type ConnectorContractState =
  | "CURRENT"
  | "CONTRACT_CHANGED"
  | "NEEDS_REPAIR"
  | "INCOMPATIBLE";

/**
 * One configuration field, exactly as the compiler emitted it.
 *
 * This is the authored field vocabulary — the same shape entity fields use —
 * plus `secret`, the one connector-only addition. Everything the form needs to
 * render a connector it has never seen is in here.
 */
export type ConnectorConfigField = {
  key: string;
  valueType?: "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "object";
  cardinality?: string | { min?: number; max?: number | "unbounded" };
  semanticType?: string;
  required?: boolean;
  secret?: boolean;
  readOnly?: boolean;
  label?: LocalizedText;
  description?: LocalizedText;
  help?: LocalizedText;
  defaultValue?: unknown;
  validation?: FieldValidation;
  render?: Partial<FieldRender> | null;
  options?: {
    type: string;
    items?: { value: string; label?: LocalizedText }[];
  };
};

export type ConnectorContractHealth = {
  state: ConnectorContractState;
  missingRequiredFields: string[];
  removedFields: string[];
  reason: string | null;
  requiresReverification: boolean;
};

export type ConnectorInstallation = {
  instanceKey: string;
  displayName: string | null;
  enabled: boolean;
  /** Secret-marked fields read back as the `__set__` sentinel, never a value. */
  configuration: Record<string, unknown>;
  contract: ConnectorContractHealth;
};

export type Connector = {
  slug: string;
  name: string;
  title: string;
  category: string | null;
  license: { spdx: string; url: string | null; notice: string | null };
  provenance: "firstParty" | "reviewed" | "thirdParty";
  requiredEntitlement: string | null;
  status: ConnectorStatus;
  configFields: ConnectorConfigField[];
  instances: "single" | "multiple";
  supportsVerify: boolean;
  /**
   * True when the contract declares OAuth, so the installation is authorized
   * through a provider consent screen rather than by typing a credential.
   */
  usesOAuth: boolean;
  installations: ConnectorInstallation[];
};

/**
 * What a secret-marked field reads back as once stored. The value itself never
 * leaves the API, so the form treats this sentinel as "set, and replaceable"
 * rather than as content.
 */
export const SECRET_SENTINEL = "__set__";

/** Statuses where there is nothing for an operator to configure yet. */
export function isConfigurable(status: ConnectorStatus): boolean {
  return status !== "NOT_LICENSED" && status !== "NOT_INSTALLED";
}
