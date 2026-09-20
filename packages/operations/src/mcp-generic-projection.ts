// SPDX-License-Identifier: BUSL-1.1
/**
 * The shared `osf_*` tools in two steps.
 *
 * A generic tool serves every entity that opted into `tools: generic`, so the
 * naive projection carried every entity's full input schema in an `anyOf`
 * branch — hundreds of kilobytes per tool for a broad session, which hosted
 * clients truncate and a model spends its context on. The projection here
 * keeps what selects the entity and what is the same for every entity, and
 * points at the describe tool for the rest:
 *
 *   1. `tools/list` advertises the generic tool with the `entity` enum, the
 *      argument properties every entity has and describes the same way
 *      (identifiers, paging, the mutation controls) verbatim, a stub for each
 *      property every entity has but describes differently (`values`,
 *      `filter`, the sort field enum), and nothing for an entity's own
 *      top-level fields — the schema stays open to them.
 *   2. `osf_describe { entity, operation }` returns the exact per-entity input
 *      schema the call is validated against.
 *
 * Every text is authored per language and resolved for the session's
 * language with English as the fallback, like the entity labels beside it.
 * The compiler measures the advertised listing with the same functions the
 * runtime projects it with, so the byte budget it enforces is the listing a
 * client receives.
 */

export const GENERIC_DESCRIBE_TOOL_NAME = "osf_describe";

/** The prefix the shared tools own; a dedicated tool may not take a name under it. */
export const GENERIC_TOOL_NAME_PREFIX = "osf_";

export type GenericToolOperation = "list" | "get" | "create" | "update" | "delete";

export const GENERIC_TOOL_OPERATIONS: readonly GenericToolOperation[] = [
  "list",
  "get",
  "create",
  "update",
  "delete",
];

export type GenericToolBranch = {
  entity: string;
  /** The entity's own title, in the session's language where the catalogue has one. */
  title: string;
  /** The per-entity input schema the call is validated against. */
  inputSchema: Record<string, unknown>;
};

type JsonObject = Record<string, unknown>;

/** A text per language; `en` is the fallback and is always authored. */
type Authored = Readonly<{ en: string; nl?: string }>;

/** Base language of a locale tag (`nl-BE` → `nl`); anything else falls back to English. */
export function genericTextLanguage(locale: string | undefined): "en" | "nl" {
  return locale?.toLowerCase().startsWith("nl") ? "nl" : "en";
}

function text(authored: Authored, locale: string | undefined): string {
  return authored[genericTextLanguage(locale)] ?? authored.en;
}

const SUMMARY: Record<GenericToolOperation, Authored> = {
  list: {
    en: "Return a page of records of one shared-catalog entity.",
    nl: "Geeft een pagina records van één entiteit uit de gedeelde catalogus terug.",
  },
  get: {
    en: "Read one record of one shared-catalog entity by id.",
    nl: "Leest één record van één entiteit uit de gedeelde catalogus op id.",
  },
  create: {
    en: "Create one record of one shared-catalog entity.",
    nl: "Maakt één record van één entiteit uit de gedeelde catalogus aan.",
  },
  update: {
    en: "Update one record of one shared-catalog entity by id.",
    nl: "Wijzigt één record van één entiteit uit de gedeelde catalogus op id.",
  },
  delete: {
    en: "Delete one record of one shared-catalog entity by id.",
    nl: "Verwijdert één record van één entiteit uit de gedeelde catalogus op id.",
  },
};

const TITLE: Record<GenericToolOperation, Authored> = {
  list: { en: "List records", nl: "Records tonen" },
  get: { en: "Read record", nl: "Record lezen" },
  create: { en: "Create record", nl: "Record aanmaken" },
  update: { en: "Update record", nl: "Record wijzigen" },
  delete: { en: "Delete record", nl: "Record verwijderen" },
};

const ENTITY_SELECTOR: Authored = {
  en:
    "Which record type this call is about. Only the values listed here " +
    "are addressable by this session; anything else is refused.",
  nl:
    "Over welk recordtype deze aanroep gaat. Alleen de hier genoemde waarden " +
    "zijn in deze sessie bereikbaar; iets anders wordt geweigerd.",
};

const ENTITY_TITLE: Authored = { en: "Entity", nl: "Entiteit" };

function differsPerEntity(key: string, operation: GenericToolOperation): Authored {
  return {
    en:
      `Differs per entity. ${GENERIC_DESCRIBE_TOOL_NAME} { entity, operation: ` +
      `"${operation}" } returns the exact schema of \`${key}\` for the entity you ` +
      `mean; the call is validated against it.`,
    nl:
      `Verschilt per entiteit. ${GENERIC_DESCRIBE_TOOL_NAME} { entity, operation: ` +
      `"${operation}" } geeft het exacte schema van \`${key}\` voor de bedoelde ` +
      `entiteit; de aanroep wordt daartegen gevalideerd.`,
  };
}

const ENTITY_OWN_PROPERTIES: Authored = {
  en:
    `Properties an entity has beyond the shared ones are accepted as well; ` +
    `${GENERIC_DESCRIBE_TOOL_NAME} lists them per entity.`,
  nl:
    `Eigenschappen die een entiteit naast de gedeelde heeft worden ook aanvaard; ` +
    `${GENERIC_DESCRIBE_TOOL_NAME} noemt ze per entiteit.`,
};

function guidance(operation: GenericToolOperation, entityCatalogUri: string): Authored {
  return {
    en:
      ` Set \`entity\` to the record type you mean. The arguments listed here are ` +
      `the ones every entity shares; the entity's own fields and a property marked ` +
      `"differs per entity" are not listed here — call ${GENERIC_DESCRIBE_TOOL_NAME} ` +
      `{ entity, operation: "${operation}" } once for the exact schema before the ` +
      `first call, and the entity's ${entityCatalogUri} resource describes its fields.`,
    nl:
      ` Zet \`entity\` op het bedoelde recordtype. De argumenten hier zijn die elke ` +
      `entiteit deelt; de eigen velden van een entiteit en een eigenschap gemarkeerd ` +
      `"verschilt per entiteit" staan hier niet — roep ${GENERIC_DESCRIBE_TOOL_NAME} ` +
      `{ entity, operation: "${operation}" } eenmaal aan voor het exacte schema vóór ` +
      `de eerste aanroep; de ${entityCatalogUri}-resource van de entiteit beschrijft haar velden.`,
  };
}

const AVAILABLE: Authored = { en: " Available to you here: ", nl: " Hier voor jou beschikbaar: " };

const DESCRIBE_TITLE: Authored = {
  en: "Describe shared-catalog arguments",
  nl: "Argumenten van de gedeelde catalogus beschrijven",
};

const DESCRIBE_DESCRIPTION: Authored = {
  en:
    "Return the exact input schema of the osf_* tools for one entity: the " +
    "per-entity arguments the generic tools only summarise. Call it once per " +
    "entity and operation before the first osf_create, osf_update or " +
    "osf_list call on it; the answer is what the call is validated against. " +
    "Omit `operation` to get every operation this session may perform on the entity.",
  nl:
    "Geeft het exacte invoerschema van de osf_*-tools voor één entiteit: de " +
    "argumenten per entiteit die de generieke tools alleen samenvatten. Roep het " +
    "eenmaal per entiteit en operatie aan vóór de eerste osf_create-, osf_update- " +
    "of osf_list-aanroep erop; het antwoord is waartegen de aanroep wordt gevalideerd. " +
    "Laat `operation` weg voor elke operatie die deze sessie op de entiteit mag uitvoeren.",
};

const DESCRIBE_ENTITY: Authored = {
  en: "The record type, as listed in the osf_* tools' `entity` enum.",
  nl: "Het recordtype, zoals genoemd in de `entity`-enum van de osf_*-tools.",
};

const DESCRIBE_OPERATION: Authored = {
  en: "One of the generic operations this session may perform; omitted means every one it may perform on the entity.",
  nl: "Eén van de generieke operaties die deze sessie mag uitvoeren; weggelaten betekent elke die ze op de entiteit mag uitvoeren.",
};

const OPERATION_TITLE: Authored = { en: "Operation", nl: "Operatie" };

/** The annotations a reader takes from a property node; kept on a stub as on a wrapper (#521). */
const PRESENTATION_KEYS = ["x-osf-type", "x-osf-reference", "x-osf-i18n"] as const;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonObject)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as JsonObject)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function propertiesOf(schema: JsonObject): Record<string, JsonObject> {
  const properties = schema.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? (properties as Record<string, JsonObject>)
    : {};
}

function requiredOf(schema: JsonObject): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
}

/** The value every variant agrees on, by structural equality, or undefined. */
function uniform(values: unknown[]): unknown {
  const [first, ...rest] = values;
  if (first === undefined) return undefined;
  const shape = stableJson(first);
  return rest.every((value) => stableJson(value) === shape) ? first : undefined;
}

/**
 * One property of the compact schema: verbatim when every entity that has it
 * describes it the same way, otherwise a stub that keeps what agrees (type,
 * title, the presentation keywords) and names the tool that has the rest.
 */
function compactProperty(
  key: string,
  variants: JsonObject[],
  operation: GenericToolOperation,
  locale: string | undefined,
): JsonObject {
  if (new Set(variants.map(stableJson)).size === 1) return variants[0]!;
  const kept: JsonObject = {};
  for (const name of ["type", "title", ...PRESENTATION_KEYS]) {
    const value = uniform(variants.map((variant) => variant[name]));
    if (value !== undefined) kept[name] = value;
  }
  return { ...kept, description: text(differsPerEntity(key, operation), locale) };
}

/**
 * Fold the per-entity input schemas of one generic tool into the compact
 * schema `tools/list` advertises. The `entity` enum is the authorization
 * boundary the model is shown; the remaining properties are the ones every
 * entity has, verbatim when the entities agree and a stub when they differ.
 * A property only some entities have (a create's own top-level fields) is
 * left out and the schema stays open to it, because a client that validates
 * the listing's schema must not refuse an argument the entity does take. A
 * property is required only when every entity requires it — the per-entity
 * validation on the call path holds the rest.
 */
export function compactGenericInputSchema(
  operation: GenericToolOperation,
  branches: readonly GenericToolBranch[],
  locale?: string,
): JsonObject {
  const properties: Record<string, JsonObject> = {
    entity: {
      type: "string",
      "x-osf-type": "string",
      enum: branches.map((branch) => branch.entity),
      title: text(ENTITY_TITLE, locale),
      description: text(ENTITY_SELECTOR, locale),
    },
  };
  const variants = new Map<string, JsonObject[]>();
  for (const branch of branches) {
    for (const [key, schema] of Object.entries(propertiesOf(branch.inputSchema))) {
      if (key === "entity") continue;
      const list = variants.get(key) ?? [];
      list.push(schema);
      variants.set(key, list);
    }
  }
  const shared = [...variants].filter(([, list]) => list.length === branches.length);
  for (const [key, list] of shared) {
    properties[key] = compactProperty(key, list, operation, locale);
  }
  const required = [
    "entity",
    ...shared
      .map(([key]) => key)
      .filter((key) => branches.every((branch) => requiredOf(branch.inputSchema).includes(key))),
  ];
  const entityOwn = variants.size > shared.length;
  return {
    type: "object",
    properties,
    required,
    ...(entityOwn
      ? { description: text(ENTITY_OWN_PROPERTIES, locale) }
      : { additionalProperties: false }),
  };
}

/**
 * The advertised text of one generic tool: what it does, how the entity is
 * selected, where the exact per-entity arguments come from, and a compact
 * per-entity summary (name and title) so the model can pick without a
 * round trip.
 */
export function genericToolText(
  operation: GenericToolOperation,
  branches: readonly GenericToolBranch[],
  entityCatalogUri: string,
  locale?: string,
): { title: string; description: string } {
  const catalogue = branches
    .map((branch) => (branch.title === branch.entity ? branch.entity : `${branch.entity} (${branch.title})`))
    .join(", ");
  return {
    title: text(TITLE[operation], locale),
    description:
      text(SUMMARY[operation], locale) +
      text(guidance(operation, entityCatalogUri), locale) +
      `${text(AVAILABLE, locale)}${catalogue}.`,
  };
}

/**
 * The describe tool itself, advertised beside the generic tools whenever a
 * session can address at least one entity through them.
 */
export function describeToolDefinition(
  entities: readonly string[],
  locale?: string,
  /** The operations the session may perform on at least one of the entities. */
  operations: readonly GenericToolOperation[] = GENERIC_TOOL_OPERATIONS,
): {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
} {
  return {
    name: GENERIC_DESCRIBE_TOOL_NAME,
    title: text(DESCRIBE_TITLE, locale),
    description: text(DESCRIBE_DESCRIPTION, locale),
    inputSchema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          "x-osf-type": "string",
          enum: [...entities],
          title: text(ENTITY_TITLE, locale),
          description: text(DESCRIBE_ENTITY, locale),
        },
        operation: {
          type: "string",
          "x-osf-type": "string",
          enum: [...operations],
          title: text(OPERATION_TITLE, locale),
          description: text(DESCRIBE_OPERATION, locale),
        },
      },
      required: ["entity"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  };
}

/** What one generic tool is advertised with, once its per-entity branches are settled for the session. */
export type GenericToolAdvertisement = {
  name: string;
  operation: GenericToolOperation;
  branches: readonly GenericToolBranch[];
  entityCatalogUri: string;
  /** The canonical envelope, when every entity behind the tool advertises one. */
  outputSchema?: JsonObject | undefined;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  /** Whether a create links the private configuration app (an entity elicits, on an https origin). */
  linksConfigurationApp: boolean;
  locale?: string | undefined;
};

/**
 * The listed generic tool: compact schema, localized text, the title
 * mirrored into the annotations, the app link on a create that elicits.
 * The runtime lists it with this; the compiler measures it with this.
 */
export function advertisedGenericTool(tool: GenericToolAdvertisement): {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  _meta?: Record<string, unknown>;
} {
  const text = genericToolText(tool.operation, tool.branches, tool.entityCatalogUri, tool.locale);
  return {
    name: tool.name,
    title: text.title,
    description: text.description,
    inputSchema: compactGenericInputSchema(tool.operation, tool.branches, tool.locale),
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations: { title: text.title, ...tool.annotations },
    ...(tool.operation === "create" && tool.linksConfigurationApp
      ? { _meta: { ui: { resourceUri: "ui://openshapeforge/configuration" } } }
      : {}),
  };
}
