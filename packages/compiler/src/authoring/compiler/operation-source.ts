// SPDX-License-Identifier: BUSL-1.1
/** Operation-backed entities share the ordinary field model, never a second output schema. */
import type { CoreEntity, CompiledField } from "../types.js";
import { operationAction } from "../entity-model.js";
import { compiledObjectSchema } from "../../field-json-schema.js";
import { entityRecordEnvelopeSchema } from "../../entity-operation-json-schema.js";

function assertSourceFieldPolicies(field: object, path: string): void {
  const classification = Reflect.get(field, "classification");
  if (Reflect.get(field, "authorization") || Reflect.get(field, "permissions") ||
      ["confidential", "pii", "bsn"].includes(classification?.sensitivity)) {
    throw new Error(`${path}: Operation-backed field policies require an executable projection adapter; protected fields cannot silently bypass authorization.`);
  }
  for (const key of ["shape", "children"]) {
    const nested = Reflect.get(field, key);
    if (Array.isArray(nested)) for (const child of nested) if (child && typeof child === "object") assertSourceFieldPolicies(child, `${path}.${child.key}`);
  }
  const item = Reflect.get(field, "item");
  if (item && typeof item === "object") assertSourceFieldPolicies(item, `${path}[]`);
}

export function operationSourceEntity(entity: CoreEntity, fields: CompiledField[], hasProfiles: boolean): CoreEntity {
  if (!entity.source) return entity;
  if (hasProfiles || entity.fields.some(field => field.persisted || field.relationship) ||
      entity.indexes?.length || entity.versioning || entity.blueprint || entity.workerAccess ||
      entity.authorization?.rowAccess) {
    throw new Error(`${entity.entity}: an Operation-backed source has no persisted fields, SQL relationships, profiles, indexes, versioning or storage policies.`);
  }
  for (const field of fields) {
    if (["first", "after", "sortField", "sortDirection"].includes(field.key)) {
      throw new Error(`${entity.entity}.${field.key}: source field collides with a reserved collection query key.`);
    }
    assertSourceFieldPolicies(field, `${entity.entity}.${field.key}`);
  }
  const identity = fields.find(field => field.key === "id");
  if (!identity || identity.baseType !== "string" || identity.cardinality !== "single" || !identity.required) {
    throw new Error(`${entity.entity}: an Operation-backed source needs a required scalar string id field.`);
  }
  const reads = Object.values(entity.operations ?? {}).filter(op => operationAction(op) === "list");
  if (reads.length !== 1 || !entity.authorization?.roles?.read?.length) {
    throw new Error(`${entity.entity}: an Operation-backed source needs one list Operation and explicit read roles.`);
  }
  const record = compiledObjectSchema(fields, {}, { requireRequired: true }) as Record<string, any>;
  for (const field of fields) if (!field.required && record.properties?.[field.key]) {
    const schema = record.properties[field.key];
    record.properties[field.key] = { anyOf: [schema, { type: "null" }],
      ...Object.fromEntries(Object.entries(schema).filter(([key]) => key.startsWith("x-osf-"))) };
  }
  const scalarFields = fields.filter(field => field.cardinality === "single" && field.baseType === "string");
  const queryFields = entity.source.query?.filterFields ?? scalarFields.map(field => field.key);
  const sortFields = entity.source.query?.sortFields ?? scalarFields.map(field => field.key);
  if (!sortFields.length || [...queryFields, ...sortFields].some(key => !scalarFields.some(field => field.key === key))) {
    throw new Error(`${entity.entity}: source query capabilities must name scalar string fields and include at least one sort field.`);
  }
  const inputProperties = Object.fromEntries(queryFields.map(key => [key, { type: "string", maxLength: 500, "x-osf-i18n": { title: fields.find(field => field.key === key)!.label } }]));
  const listInput = { type: "object", additionalProperties: false, properties: {
    first: { type: "integer", minimum: 1, maximum: 200, default: 50, "x-osf-i18n": { title: { en: "Page size", nl: "Paginagrootte" } } },
    after: { type: "string", "x-osf-i18n": { title: { en: "Cursor", nl: "Cursor" } } }, ...inputProperties,
    sortField: { type: "string", enum: sortFields, "x-osf-i18n": { title: { en: "Sort field", nl: "Sorteerveld" },
      enum: Object.fromEntries(sortFields.map(key => [key, fields.find(field => field.key === key)!.label])) } },
    sortDirection: { type: "string", enum: ["asc", "desc"], "x-osf-i18n": { title: { en: "Sort direction", nl: "Sorteerrichting" }, enum: { asc: { en: "Ascending", nl: "Oplopend" }, desc: { en: "Descending", nl: "Aflopend" } } } },
  } };
  const idSchema = record.properties.id;
  const operations = Object.fromEntries(Object.entries(entity.operations ?? {}).map(([key, op]) => {
    const action = operationAction(op);
    if (op.implementation.type === "entity" || op.implementation.type === "collection" ||
        (op.implementation.type === "plugin" && action && action !== "list" && action !== "get")) {
      throw new Error(`${entity.entity}.${key}: an Operation-backed source permits named plugin mutations, never generated SQL CRUD.`);
    }
    if (action !== "list" && action !== "get") {
      if (op.target?.scope === "record") for (const [inputKey, fieldKey] of Object.entries(op.target.inputBindings ?? {})) {
        const field = fields.find(candidate => candidate.key === fieldKey);
        const property = (op.input?.schema.properties as Record<string, any> | undefined)?.[inputKey];
        if (inputKey === op.target.inputField || !field?.required || field.cardinality !== "single" ||
            !["string", "integer", "number", "boolean"].includes(field.baseType) ||
            property?.type !== field.baseType || !(op.input?.schema.required as string[] | undefined)?.includes(inputKey)) {
          throw new Error(`${entity.entity}.${key}: target inputBindings must map a required scalar record field to a matching required input, never override the target id.`);
        }
      }
      return [key, op];
    }
    if (key !== action) throw new Error(`${entity.entity}: source read Operations must use the canonical list/get keys.`);
    const { action: _action, ...implementation } = op.implementation as Extract<NonNullable<CoreEntity["operations"]>[string]["implementation"], { type: "plugin" }>;
    return [key, { ...op, implementation,
      target: action === "list" ? { scope: "collection" } : { scope: "record", inputField: "id" },
      input: { schema: action === "list" ? listInput : { type: "object", additionalProperties: false, required: ["id"], properties: { id: idSchema } } },
      output: { schema: action === "get" ? entityRecordEnvelopeSchema(record) : { type: "object", additionalProperties: false,
        required: ["items", "nextCursor", "totalCount"], properties: {
          items: { type: "array", items: record, "x-osf-i18n": { title: { en: "Records", nl: "Records" } } },
          nextCursor: { type: ["string", "null"], "x-osf-i18n": { title: { en: "Next cursor", nl: "Volgende cursor" } } },
          totalCount: { type: "integer", minimum: 0, "x-osf-i18n": { title: { en: "Total count", nl: "Totaal aantal" } } },
        } } },
      auth: { mode: "session", roles: [...entity.authorization!.roles.read] }, tenancy: { mode: "required" },
      errors: [
        { status: 400, code: "VALIDATION", description: "Invalid record or collection query." },
        { status: 401, code: "UNAUTHENTICATED", description: "Sign in to read this entity." },
        { status: 401, code: "TENANT_REQUIRED", description: "Select an organization to read this entity." },
        { status: 403, code: "FORBIDDEN", description: "Entity read permission is required." },
        ...(action === "get" ? [{ status: 404, code: "NOT_FOUND", description: "Record not found in this organization." }] : []),
        { status: 503, code: "OPERATION_UNAVAILABLE", description: "The entity source is unavailable." },
        ...op.errors!.filter(error => !["VALIDATION", "UNAUTHENTICATED", "TENANT_REQUIRED", "FORBIDDEN", "NOT_FOUND", "OPERATION_UNAVAILABLE"].includes(error.code)),
      ],
    }];
  }));
  return { ...entity, operations } as CoreEntity;
}
