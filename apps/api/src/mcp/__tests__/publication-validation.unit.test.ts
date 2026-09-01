// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for publication-time validation: the write that would make a
 * derived-tool definition visible is refused — with every problem named —
 * when its chain is broken, its provider has no usable connection, or its
 * name cannot project; and passes silently when the row is fit to serve.
 */
import { describe, expect, it } from "bun:test";
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
    bindingsField: "bindings",
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

function readerFor(data: Record<string, Row[]>) {
  return async (table: string, filter: Row): Promise<Row[]> =>
    (data[table] ?? []).filter((row) =>
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
const OPERATION: Row = { id: "op-1", key: "search", providerId: "prov-1" };
const CONNECTION: Row = {
  id: "conn-1",
  providerId: "prov-1",
  values: { subdomain: "acme", email: "a@b.c", apiToken: { ciphertext: "x", keyId: "k" } },
};
const ROW: Row = {
  id: "svc-1",
  key: "find-tickets",
  status: "published",
  bindings: [{ operationId: "op-1", order: 1 }],
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

  it("names a binding whose operation does not exist", async () => {
    const message = await failure({
      entry: ENTRY,
      row: { ...ROW, bindings: [{ operationId: "missing", order: 1 }] },
      reservedNames: new Set(),
      readRows: readerFor({ "core.providers": [PROVIDER], "core.connections": [CONNECTION] }),
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

  it("aggregates every problem into one readable refusal", async () => {
    const message = await failure({
      entry: ENTRY,
      row: { key: "x!", status: "published", bindings: [] },
      reservedNames: new Set(),
      readRows: readerFor({}),
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
