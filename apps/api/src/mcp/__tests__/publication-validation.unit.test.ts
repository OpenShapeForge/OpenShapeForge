// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for publication-time validation: the write that would make a
 * derived-tool definition visible is refused — with every problem named —
 * when its chain is broken, its provider has no usable connection, or its
 * name cannot project; and passes silently when the row is fit to serve.
 */
import { describe, expect, it } from "bun:test";
import { MAX_BINDINGS_PER_OWNER } from "../execution-bindings.js";
import {
  requiredAuthValueKeys,
  validateVisibleDefinition,
} from "../publication-validation.js";
import type { DerivedToolsCatalogEntry } from "../derived-tools.js";

const ENTRY: DerivedToolsCatalogEntry = {
  entity: "Service",
  table: "core.services",
  roles: ["employee"],
  keyField: "key",
  descriptionField: "description",
  inputFieldsField: "inputFields",
  visibleWhen: { field: "status", equals: "published" },
  execution: {
    bindingsRelation: "capabilityBindings",
    bindingsEntity: "Binding",
    bindingsTable: "core.bindings",
    parentRef: "serviceId",
    operationRef: "operationId",
    operationEntity: "Operation",
    operationTable: "core.operations",
    providerRef: "providerId",
    providerEntity: "Provider",
    providerTable: "core.providers",
    connectionEntity: "Connection",
    connectionTable: "core.connections",
    connectionProviderRef: "providerId",
    connectionValuesField: "values",
  },
};

type Row = Record<string, unknown>;

const BINDING: Row = {
  id: "bind-1",
  serviceId: "svc-1",
  order: 1,
  operationId: "op-1",
};

function readerFor(data: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { "core.bindings": [BINDING], ...data };
  return async (table: string, filter: Row): Promise<Row[]> =>
    (tables[table] ?? []).filter((row) =>
      Object.entries(filter).every(([key, value]) => row[key] === value),
    );
}

const PROVIDER: Row = {
  id: "prov-1",
  name: "Ticketing",
  auth: { profile: "basic", scheme: "basic", usernameTemplate: "{email}/token", passwordFrom: "apiToken" },
  definitions: [
    { key: "subdomain", required: true },
    { key: "apiToken", required: true },
  ],
};
const OPERATION: Row = {
  id: "op-1",
  key: "search",
  providerId: "prov-1",
  inputFields: [{ key: "version", osfType: "string" }],
};
const CONNECTION: Row = {
  id: "conn-1",
  providerId: "prov-1",
  values: { subdomain: "acme", email: "a@b.c", apiToken: { ciphertext: "x", keyId: "k" } },
};
const ROW: Row = {
  id: "svc-1",
  key: "find-tickets",
  status: "published",
};

async function failure(input: Parameters<typeof validateVisibleDefinition>[0]): Promise<string> {
  try {
    await validateVisibleDefinition(input);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected validation to refuse");
}

describe("validateVisibleDefinition", () => {
  it("passes a complete chain with a usable tenant connection", async () => {
    await validateVisibleDefinition({
      entry: ENTRY,
      row: ROW,
      rowId: "svc-1",
      reservedNames: new Set(["list_services"]),
      providerDefinitionsField: "definitions",
      readRows: readerFor({
        "core.operations": [OPERATION],
        "core.providers": [PROVIDER],
        "core.connections": [CONNECTION],
        "core.services": [ROW],
      }),
    });
  });

  it("accepts a presence selector and refuses malformed or ambiguous selectors", async () => {
    const row = {
      ...ROW,
      inputFields: [{ key: "dealId", osfType: "string" }],
    };
    const readRows = readerFor({
      "core.operations": [OPERATION],
      "core.providers": [PROVIDER],
      "core.connections": [CONNECTION],
      "core.services": [],
      "core.bindings": [
        { ...BINDING, when: { field: "dealId", present: true } },
      ],
    });
    await validateVisibleDefinition({
      entry: ENTRY,
      row,
      reservedNames: new Set(),
      readRows,
    });

    for (const when of [
      { field: "dealId" },
      { field: "dealId", present: false },
      { field: "dealId", equals: "deal-1", present: true },
    ]) {
      const message = await failure({
        entry: ENTRY,
        row,
        reservedNames: new Set(),
        readRows: readerFor({
          "core.operations": [OPERATION],
          "core.providers": [PROVIDER],
          "core.connections": [CONNECTION],
          "core.bindings": [{ ...BINDING, when }],
        }),
      });
      expect(message).toContain("binding 1: when");
    }
  });

  it("publishes a fixed If-Match mapping from a declared scalar input", async () => {
    await validateVisibleDefinition({
      entry: ENTRY,
      row: ROW,
      reservedNames: new Set(),
      readRows: readerFor({
        "core.operations": [
          {
            ...OPERATION,
            requestMapping: {
              headers: [{ field: "version", header: "If-Match" }],
            },
          },
        ],
        "core.providers": [PROVIDER],
        "core.connections": [CONNECTION],
        "core.services": [],
      }),
    });
  });

  it("refuses unsafe authored header mappings before publication", async () => {
    const invalidOperations: Row[] = [
      {
        ...OPERATION,
        requestMapping: {
          headers: [{ field: "missing", header: "If-Match" }],
        },
      },
      {
        ...OPERATION,
        requestMapping: {
          headers: [{ field: "version", header: "Authorization" }],
        },
      },
      ...[
        "Content-Type",
        "Accept",
        "__proto__",
        "prototype",
        "constructor",
      ].map((header) => ({
        ...OPERATION,
        requestMapping: {
          headers: [{ field: "version", header }],
        },
      })),
      {
        ...OPERATION,
        requestMapping: {
          headers: [
            { field: "version", header: "If-Match" },
            { field: "version", header: "if-match" },
          ],
        },
      },
    ];
    for (const operation of invalidOperations) {
      const message = await failure({
        entry: ENTRY,
        row: ROW,
        reservedNames: new Set(),
        readRows: readerFor({
          "core.operations": [operation],
          "core.providers": [PROVIDER],
          "core.connections": [CONNECTION],
          "core.services": [],
        }),
      });
      expect(message).toContain("binding 1: requestMapping.headers");
    }
  });

  it("refuses a header target owned by configured authentication", async () => {
    const provider = {
      ...PROVIDER,
      auth: {
        scheme: "header",
        headerName: "  X-Api-Key  ",
        tokenFrom: "apiToken",
      },
    };
    const message = await failure({
      entry: ENTRY,
      row: ROW,
      reservedNames: new Set(),
      readRows: readerFor({
        "core.operations": [
          {
            ...OPERATION,
            requestMapping: {
              headers: [{ field: "version", header: "x-API-key" }],
            },
          },
        ],
        "core.providers": [provider],
        "core.connections": [CONNECTION],
        "core.services": [],
      }),
    });
    expect(message).toContain("owned by configured authentication");
  });

  it("names a binding whose operation does not exist", async () => {
    const message = await failure({
      entry: ENTRY,
      row: ROW,
      reservedNames: new Set(),
      readRows: readerFor({
        "core.providers": [PROVIDER],
        "core.connections": [CONNECTION],
        "core.bindings": [{ ...BINDING, operationId: "missing" }],
      }),
    });
    expect(message).toContain("binding 1 references Operation missing");
    expect(message).toContain("does not exist");
  });

  it("refuses a provider without any connection, naming the next step", async () => {
    const message = await failure({
      entry: ENTRY,
      row: ROW,
      reservedNames: new Set(),
      readRows: readerFor({
        "core.operations": [OPERATION],
        "core.providers": [PROVIDER],
        "core.connections": [],
      }),
    });
    expect(message).toContain('no Connection is configured for Provider "Ticketing"');
    expect(message).toContain("create one first");
  });

  it("ignores personal connections when judging tenant configuration", async () => {
    const message = await failure({
      entry: ENTRY,
      row: ROW,
      reservedNames: new Set(),
      readRows: readerFor({
        "core.operations": [OPERATION],
        "core.providers": [PROVIDER],
        "core.connections": [{ ...CONNECTION, ownerUserId: "user-1" }],
      }),
    });
    expect(message).toContain("no Connection is configured");
  });

  it("lists missing required configuration and auth values", async () => {
    const message = await failure({
      entry: ENTRY,
      row: ROW,
      reservedNames: new Set(),
      providerDefinitionsField: "definitions",
      readRows: readerFor({
        "core.operations": [OPERATION],
        "core.providers": [PROVIDER],
        "core.connections": [{ ...CONNECTION, values: { subdomain: "acme" } }],
      }),
    });
    expect(message).toContain("missing required configuration values: apiToken, email");
  });

  it("requires the OAuth client on the tenant connection for personal sign-in, not tokens", async () => {
    const provider: Row = {
      ...PROVIDER,
      auth: { profile: "oauth2AuthorizationCode", authorizationUrl: "https://a", tokenUrl: "https://t" },
      definitions: [],
    };
    const withClient = readerFor({
      "core.operations": [OPERATION],
      "core.providers": [provider],
      "core.connections": [
        { id: "conn-1", providerId: "prov-1", values: { clientId: "cid", clientSecret: { ciphertext: "x", keyId: "k" } } },
      ],
      "core.services": [],
    });
    await validateVisibleDefinition({
      entry: ENTRY,
      row: ROW,
      reservedNames: new Set(),
      readRows: withClient,
    });

    const message = await failure({
      entry: ENTRY,
      row: ROW,
      reservedNames: new Set(),
      readRows: readerFor({
        "core.operations": [OPERATION],
        "core.providers": [provider],
        "core.connections": [{ id: "conn-1", providerId: "prov-1", values: {} }],
      }),
    });
    expect(message).toContain("clientId, clientSecret");
  });

  it("refuses reserved and already-taken tool names, and unusable keys", async () => {
    const reserved = await failure({
      entry: ENTRY,
      row: { ...ROW, key: "list-services" },
      reservedNames: new Set(["list_services"]),
      readRows: readerFor({
        "core.operations": [OPERATION],
        "core.providers": [PROVIDER],
        "core.connections": [CONNECTION],
      }),
    });
    expect(reserved).toContain('"list_services" is reserved');

    const taken = await failure({
      entry: ENTRY,
      row: { ...ROW, id: "svc-2" },
      rowId: "svc-2",
      reservedNames: new Set(),
      readRows: readerFor({
        "core.operations": [OPERATION],
        "core.providers": [PROVIDER],
        "core.connections": [CONNECTION],
        "core.services": [{ ...ROW, id: "svc-1" }],
      }),
    });
    expect(taken).toContain('already provides the tool name "find_tickets"');

    const unusable = await failure({
      entry: ENTRY,
      row: { ...ROW, key: "9-nope" },
      reservedNames: new Set(),
      readRows: readerFor({
        "core.operations": [OPERATION],
        "core.providers": [PROVIDER],
        "core.connections": [CONNECTION],
      }),
    });
    expect(unusable).toContain("does not yield a usable tool name");
  });

  it("refuses a colliding order as NOT_PUBLISHABLE, not SERVICE_MISCONFIGURED", async () => {
    const input = {
      entry: ENTRY,
      row: ROW,
      reservedNames: new Set(),
      readRows: readerFor({
        "core.operations": [OPERATION],
        "core.providers": [PROVIDER],
        "core.connections": [CONNECTION],
        "core.bindings": [
          { ...BINDING, id: "bind-1", order: 1 },
          { ...BINDING, id: "bind-2", order: 1, operationId: "op-1" },
        ],
      }),
    };
    try {
      await validateVisibleDefinition(input);
      throw new Error("expected validation to refuse");
    } catch (error) {
      expect(error).toMatchObject({ code: "NOT_PUBLISHABLE" });
      expect(String((error as Error).message)).toContain("unique integer order");
      expect(String((error as Error).message)).toContain("cannot be made visible");
    }
  });

  it("sorts bindings by order before naming problems", async () => {
    const message = await failure({
      entry: ENTRY,
      row: ROW,
      reservedNames: new Set(),
      readRows: readerFor({
        "core.providers": [PROVIDER],
        "core.connections": [CONNECTION],
        "core.bindings": [
          { ...BINDING, id: "bind-2", order: 2, operationId: "missing-later" },
          { ...BINDING, id: "bind-1", order: 1, operationId: "missing-first" },
        ],
      }),
    });
    expect(message).toContain("binding 1 references Operation missing-first");
    expect(message).toContain("binding 2 references Operation missing-later");
  });

  it("refuses a relation collection that exceeds the per-owner maximum", async () => {
    const bindings = Array.from({ length: MAX_BINDINGS_PER_OWNER + 1 }, (_, index) => ({
      id: `b-${index}`,
      serviceId: "svc-1",
      order: index + 1,
      operationId: "op-1",
    }));
    const message = await failure({
      entry: ENTRY,
      row: { ...ROW, id: "svc-1" },
      reservedNames: new Set(),
      readRows: readerFor({
        "core.operations": [OPERATION],
        "core.providers": [PROVIDER],
        "core.connections": [CONNECTION],
        "core.bindings": bindings,
      }),
    });
    expect(message).toContain(`exceeds ${MAX_BINDINGS_PER_OWNER} bindings`);
  });

  it("aggregates every problem into one readable refusal", async () => {
    const message = await failure({
      entry: ENTRY,
      row: { key: "x!", status: "published" },
      reservedNames: new Set(),
      readRows: readerFor({ "core.bindings": [] }),
    });
    expect(message).toContain("cannot be made visible");
    expect(message).toContain("usable tool name");
    expect(message).toContain("collection is empty");
  });
});

describe("requiredAuthValueKeys", () => {
  it("derives the connection keys each scheme resolves", () => {
    expect(
      requiredAuthValueKeys({ scheme: "basic", usernameTemplate: "{email}/token", passwordFrom: "apiToken" }).sort(),
    ).toEqual(["apiToken", "email"]);
    expect(requiredAuthValueKeys({ scheme: "bearer", tokenFrom: "token" })).toEqual(["token"]);
    expect(requiredAuthValueKeys({ scheme: "oauth2ClientCredentials" }).sort()).toEqual([
      "clientId",
      "clientSecret",
    ]);
    expect(requiredAuthValueKeys({ profile: "oauth2AuthorizationCode" }).sort()).toEqual([
      "clientId",
      "clientSecret",
    ]);
    // Sign-in tokens are issued by the runtime AFTER consent: scheme-derived
    // keys must not be demanded of the tenant connection.
    expect(
      requiredAuthValueKeys({
        profile: "oauth2AuthorizationCode",
        scheme: "bearer",
        tokenFrom: "access_token",
      }).sort(),
    ).toEqual(["clientId", "clientSecret"]);
    expect(requiredAuthValueKeys(undefined)).toEqual([]);
  });
});
