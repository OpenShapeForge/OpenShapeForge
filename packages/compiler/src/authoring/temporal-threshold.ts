// SPDX-License-Identifier: BUSL-1.1
/** A deliberately bounded derivation, not an arbitrary expression language. */
export type TemporalThresholdDefinition = {
  kind: "temporalThreshold";
  field: string;
  thresholdDays: string;
};

export type TemporalField = {
  key: string;
  osfType: string;
  cardinality?: string;
  persisted?: unknown;
  computed?: unknown;
};

/** Validate the supported one-hop relationship form before generating a contract. */
export function validateTemporalThreshold(
  definition: TemporalThresholdDefinition,
  rootFields: readonly TemporalField[],
  relatedFields: (entity: string) => readonly TemporalField[] | undefined,
): void {
  const tracked = rootFields.find(field => field.key === definition.field);
  if (!tracked || !tracked.persisted || tracked.computed || tracked.cardinality === "collection") {
    throw new Error("Temporal threshold requires a persisted single-valued tracked field.");
  }
  const parts = definition.thresholdDays.split(".");
  if (parts.length !== 2 || parts[0] !== tracked.key || !parts[1]) {
    throw new Error("Temporal threshold must reference a numeric field on the tracked relationship.");
  }
  const target = relatedFields(tracked.osfType);
  const threshold = target?.find(field => field.key === parts[1]);
  if (!threshold || !threshold.persisted || threshold.computed || threshold.cardinality === "collection" ||
      !["integer", "number", "decimal"].includes(threshold.osfType)) {
    throw new Error("Temporal threshold must reference a persisted single-valued numeric field.");
  }
}
