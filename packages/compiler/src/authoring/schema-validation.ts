// SPDX-License-Identifier: BUSL-1.1
/**
 * Validates authoring documents against the JSON Schemas in `config/schemas/`.
 *
 * Those schemas are cited as the authoring contract — in docs, in comments, in
 * editor tooling — but until now nothing validated anything against them (#182).
 * The only consumer was a `JSON.parse` in `check:authoring-local`, which proved
 * the files were syntactically valid JSON and nothing more. Drift was therefore
 * silent in both directions, and it had happened: `core-entity.schema.json`
 * still described the pre-`valueType` field shape, and `connector.schema.json`
 * declared a `reliability.timeoutMs` the compiler never reads.
 *
 * Two properties this module is built around:
 *
 *   1. **Every schema must load.** They cross-reference each other, in two
 *      different styles — some by full `$id` URI, some by bare filename — so
 *      each is registered under both keys. A dangling `$ref` used to surface as
 *      "can't resolve reference" at validation time, i.e. never, because
 *      nothing validated.
 *   2. **Every authoring kind must be accounted for.** A kind maps to a schema
 *      or appears in UNSCHEMAD_KINDS with a reason. A new kind that does
 *      neither fails the gate, so "add an authoring artifact type" cannot
 *      quietly mean "add an unvalidated authoring artifact type".
 *
 * This does NOT replace the identifier allowlists in `loader.ts` and
 * `connector-loader.ts`. A shape schema is not injection defence: those
 * patterns guard names that are spliced verbatim into generated TS, GraphQL,
 * SQL, route strings and MCP tool names, and they must keep failing closed
 * independently of whether a schema happens to agree.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import draft07MetaSchema from "ajv/dist/refs/json-schema-draft-07.json" with { type: "json" };
import { parse as parseYaml } from "yaml";

export const SCHEMAS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "config",
  "schemas",
);

/**
 * Authoring `kind` -> the schema that describes it.
 *
 * Explicit rather than derived from each schema's `properties.kind.const`,
 * because two schemas claim `semanticTypeCatalog` (a v1 and a v2 shape) and
 * only one of them describes what this repo authors today. Deriving the map
 * would make that ambiguity silent again.
 */
export const SCHEMA_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
  coreEntity: "core-entity.schema.json",
  connector: "connector.schema.json",
  authorizationConfig: "authorization-config.schema.json",
  retentionPolicyCatalog: "retention-policy-catalog.schema.json",
  semanticTypeCatalog: "semantic-type-catalog.schema.json",
  transformCatalog: "transform-catalog.schema.json",
  entityProfile: "entity-profile.schema.json",
  entityMapping: "entity-mapping.schema.json",
  view: "view.schema.json",
  workflowNode: "workflow-node.schema.json",
});

/**
 * Kinds this repo authors that no schema describes yet, each with the reason it
 * is not simply an oversight. Listing them is the point: the gate reports them
 * by name, so "unvalidated" is a visible state rather than a silent one.
 */
export const UNSCHEMAD_KINDS: Readonly<Record<string, string>> = Object.freeze({
  baseEntity:
    "the merged-in meta-field set; shares the field shape with coreEntity but not its envelope (no module, no authorization)",
  appShell: "shell/navigation authoring, consumed only by the web generator",
  componentCatalog: "render-component registry",
  coreReferentiedataCatalog: "reference-data seed catalog",
  fieldAuthoringProfileCatalog: "field authoring presets",
});

export type AuthoringValidator = {
  /** Schema files loaded, in directory order. */
  readonly schemaFiles: readonly string[];
  /** Schemas no authoring kind maps to and no other schema references. */
  readonly orphanSchemas: readonly string[];
  /**
   * Validates `document` against the schema for its `kind`.
   *
   * Returns the schema used, or null when the kind is a known-unschemad one.
   * Throws on a violation, and on an unknown kind.
   */
  validate(document: unknown, origin: string): string | null;
  /**
   * Reads, parses and validates one authoring YAML file. Returns the parsed
   * document alongside the schema used, so a caller that was going to parse it
   * anyway does not parse twice — and, more to the point, cannot parse it
   * differently from how it was validated.
   */
  validateFile(path: string, origin: string): { document: unknown; schema: string | null };
};

function formatErrors(errors: readonly object[] | null | undefined): string {
  const shown = (errors ?? []).slice(0, 20).map((error) => {
    const { instancePath, message, params } = error as {
      instancePath?: string;
      message?: string;
      params?: Record<string, unknown>;
    };
    const where = instancePath && instancePath.length > 0 ? instancePath : "(document root)";
    const detail = Object.entries(params ?? {})
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ");
    return `  ${where}: ${message ?? "is invalid"}${detail ? ` (${detail})` : ""}`;
  });
  const remaining = (errors ?? []).length - shown.length;
  return shown.join("\n") + (remaining > 0 ? `\n  … and ${remaining} more` : "");
}

let sharedValidator: AuthoringValidator | null = null;

/**
 * The process-wide validator over the shipped schema directory.
 *
 * Building one compiles fifteen cross-referencing schemas; the loader runs per
 * file, so this is memoized. Tests that need a different schema directory call
 * createAuthoringValidator directly.
 */
export function authoringValidator(): AuthoringValidator {
  sharedValidator ??= createAuthoringValidator();
  return sharedValidator;
}

export function createAuthoringValidator(
  schemasDir: string = SCHEMAS_DIR,
): AuthoringValidator {
  // strict:false — these schemas carry annotation keywords ajv's strict mode
  // rejects (and would reject on load, before validating anything).
  const ajv = new Ajv2020.default({ allErrors: true, strict: false });
  // The directory is not one dialect: gateway-routes.schema.json is draft-07.
  // Without its meta-schema, ajv refuses to even register that file and the
  // whole registry fails to build.
  ajv.addMetaSchema(draft07MetaSchema);

  const schemaFiles = readdirSync(schemasDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const referenced = new Set<string>();

  for (const file of schemaFiles) {
    const raw = readFileSync(join(schemasDir, file), "utf8");
    const schema = JSON.parse(raw) as { $id?: string };
    // Registered under both keys because both styles appear in $refs here.
    if (schema.$id && schema.$id !== file) ajv.addSchema(schema, schema.$id);
    ajv.addSchema(schema, file);
    for (const match of raw.matchAll(/"\$ref"\s*:\s*"([^"#]+)/g)) {
      referenced.add(match[1]!.split("/").pop()!);
    }
  }

  // Compile every schema up front. A dangling $ref only fails when the schema
  // is compiled, so deferring this would leave broken schemas undetected until
  // something happened to author that kind.
  const broken: string[] = [];
  for (const file of schemaFiles) {
    try {
      ajv.getSchema(file);
    } catch (error) {
      broken.push(`  ${file}: ${(error as Error).message}`);
    }
  }
  if (broken.length > 0) {
    throw new Error(
      `Schemas in ${schemasDir} do not compile:\n${broken.join("\n")}\n\n` +
        "A $ref that resolves to nothing makes the schema unusable; fix the " +
        "reference or remove the schema.",
    );
  }

  const mapped = new Set(Object.values(SCHEMA_BY_KIND));
  const orphanSchemas = schemaFiles.filter(
    (file) => !mapped.has(file) && !referenced.has(file),
  );

  const validator: AuthoringValidator = {
    schemaFiles,
    orphanSchemas,
    validateFile(path: string, origin: string) {
      let document: unknown;
      try {
        document = parseYaml(readFileSync(path, "utf8"));
      } catch (error) {
        throw new Error(`${origin} is not valid YAML: ${(error as Error).message}`);
      }
      return { document, schema: validator.validate(document, origin) };
    },
    validate(document: unknown, origin: string): string | null {
      const kind = (document as { kind?: unknown } | null)?.kind;
      if (typeof kind !== "string") {
        throw new Error(
          `${origin} declares no \`kind\`, so no schema can be selected for it.`,
        );
      }
      if (kind in UNSCHEMAD_KINDS) return null;

      const schemaFile = SCHEMA_BY_KIND[kind];
      if (!schemaFile) {
        throw new Error(
          `${origin} declares kind "${kind}", which maps to no schema.\n\n` +
            "Add it to SCHEMA_BY_KIND with the schema that describes it, or to " +
            "UNSCHEMAD_KINDS with the reason it has none. An authoring kind " +
            "must not become unvalidated by omission.",
        );
      }

      const validate = ajv.getSchema(schemaFile);
      if (!validate) {
        throw new Error(`Schema ${schemaFile} for kind "${kind}" is not in ${schemasDir}.`);
      }
      if (!validate(document)) {
        throw new Error(
          `${origin} does not match ${schemaFile}:\n${formatErrors(validate.errors)}`,
        );
      }
      return schemaFile;
    },
  };
  return validator;
}
