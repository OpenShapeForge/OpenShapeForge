// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { FIELD_ITEM_ID } from "@openshapeforge/operations";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import type { GeneratedCrudTable } from "./types.js";

// Bun shares imported modules across test files. A separate process guarantees
// this fixture is registered before any public runtime catalog is constructed.
if (process.env.OSF_FIELD_POLICY_DB_ISOLATED !== "1") {
  test("protected-field PostgreSQL regressions use an isolated caller catalog", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, OSF_FIELD_POLICY_DB_ISOLATED: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`Isolated protected-field regressions failed.\n${stdout}${stderr}`);
    console.log(stderr.trim());
    expect(code).toBe(0);
  }, 90_000);
} else {
  // Register a distinct compiler-emitted fixture before the runtime constructs
  // its catalog. Existing entity tables and their cached role sets stay intact.
  const fixturePath = new URL("../../../../../packages/compiler/src/authoring/field-value-policy.fixtures.ts", import.meta.url).pathname;
  const generatorPath = new URL("../../../../../packages/compiler/src/generate.ts", import.meta.url).pathname;
  const { compileProtectedFieldsFixture } = await import(fixturePath);
  const { generateArtifacts } = await import(generatorPath);
  let fixtureContract: any;
  const artifacts = generateArtifacts(compileProtectedFieldsFixture((candidate: { contract: typeof fixtureContract }) => { fixtureContract = candidate.contract; }, {
    configureFields: (fields: Array<{ key: string; children?: unknown[] }>) => {
      fields.push({ key: "key", osfType: "string", label: { en: "Configuration key" }, persisted: { column: "key", storageClass: "core" } } as never);
      fields.push({ key: "definitionId", osfType: "string", immutable: true, label: { en: "Definition record" }, persisted: { column: "definition_id", storageClass: "core" } } as never);
      fields.push({ key: "acceptanceId", osfType: "string", immutable: true, label: { en: "Acceptance record" }, persisted: { column: "acceptance_id", storageClass: "core" } } as never);
      fields.push({ key: "definitions", osfType: "object", cardinality: "collection", label: { en: "Definitions" }, persisted: { column: "definitions", storageClass: "core" }, children: [
        { key: "key", osfType: "string", label: { en: "Key" } },
        { key: "osfType", osfType: "string", label: { en: "Type" } },
        { key: "classification", osfType: "object", label: { en: "Classification" }, children: [{ key: "sensitivity", osfType: "string", label: { en: "Sensitivity" } }] },
      ] } as never);
      fields.find(field => field.key === "data")?.children?.push(
        { key: "otherVisible", osfType: "string", label: { en: "Other visible" } },
        { key: "token", osfType: "object", label: { en: "Token" }, classification: { sensitivity: "confidential" } },
      );
    },
  }));
  const table: GeneratedCrudTable = JSON.parse(artifacts.find((artifact: { path: string }) => artifact.path.endsWith("db/manifest.json"))!.contents).tables[0];
  table.name = `field-policy-regression-${randomUUID()}`;
  const { default: runtimeManifest } = await import("../../generated/db/manifest.json", { with: { type: "json" } });
  (runtimeManifest.tables as unknown as GeneratedCrudTable[]).push(table);
  const { default: operationCatalog } = await import("../../generated/operations/catalog.json", { with: { type: "json" } });
  const schemaProjectorPath = new URL("../../../../../packages/compiler/src/entity-operation-json-schema.js", import.meta.url).pathname;
  const { entityOperationJsonSchemas } = await import(schemaProjectorPath);
  const fixtureOperations: any[] = Object.values(fixtureContract!.entityOperations);
  const secureCreate = fixtureOperations.find((operation: { intent: string }) => operation.intent === "create");
  secureCreate!.interaction.secureInput = { type: "secureInput", sourceField: "definitionId", sourceEntity: "ProtectedFieldsFixture", definitionsField: "definitions", into: "data" };
  for (const operation of fixtureOperations) (operationCatalog.entityOperations as unknown[]).push({ ...operation,
    ...entityOperationJsonSchemas(fixtureContract!, operation!, [fixtureContract!], {}),
  });
  const { runMigrationChain } = await import("../../db/migration-chain.js");
  const { createGeneratedEntity, updateGeneratedEntity, mergeGeneratedEntityObjectForTable } = await import("./mutations.js");
  const { getGeneratedEntity, listGeneratedEntities } = await import("./queries.js");
  const { storeElicitedValues } = await import("../../mcp/elicitation.js");
  const { decryptSecret, keyringFromEnv } = await import("../../connectors/secrets.js");

  const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
  const database = `field_policy_${randomUUID().replaceAll("-", "")}`;
  const editor = { tenantId: randomUUID(), userId: randomUUID(), roles: ["Templates.Manage"], groups: [], scope: "self" as const };
  const writer = { ...editor, roles: [...editor.roles, "Sensitive.Read", "Sensitive.Write"] };
  const viewer = { ...editor, roles: ["Templates.Read"] };
  let admin: SQL;
  let privileged: DatabaseRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    const url = new URL(adminUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") {
      throw new Error("Field policy tests require a local scratch admin database.");
    }
    admin = new SQL(adminUrl, { max: 1 });
    await admin.unsafe(`create database "${database}"`);
    url.pathname = `/${database}`;
    privileged = createDatabaseRuntime({ databaseUrl: url.toString() });
    await privileged.db.connection().execute((connection) => runMigrationChain(connection));
    url.username = "openshapeforge_app"; url.password = "openshapeforge_app";
    runtime = createDatabaseRuntime({ databaseUrl: url.toString() });
    await sql.raw(artifacts.find((artifact: { path: string }) => artifact.path.endsWith("schema.sql"))!.contents).execute(privileged.db);
    await sql`grant select, insert, update, delete on erp.protected_fields_fixtures to openshapeforge_app`.execute(privileged.db);
    // Exercise database-authored values, which do not enter the submitted map.
    await sql`alter table erp.protected_fields_fixtures alter column data set default
      '{"visible":"default public","restricted":"default secret","fixed":"default provenance","contacts":[{"name":"Default","private":"default contact secret"}]}'::jsonb`.execute(privileged.db);
    await sql`alter table erp.protected_fields_fixtures alter column explicit_secret set default 'default top secret'`.execute(privileged.db);
  }, 90_000);

  afterAll(async () => {
    await runtime?.close(); await privileged?.close();
    await admin?.unsafe(`drop database if exists "${database}" with (force)`); await admin?.close();
  });

  async function stored(id: string) {
    return (await sql<{ row: Record<string, unknown> }>`select to_jsonb(t.*) as row
      from erp.protected_fields_fixtures t where id = ${id}::uuid`.execute(privileged.db)).rows[0]!.row;
  }
  type Contact = { name?: string; private?: unknown; [FIELD_ITEM_ID]?: string };
  const contactsOf = (row: Record<string, unknown>) => (row.data as { contacts: Contact[] }).contacts;
  function identify(contact: Contact, changes: Partial<Contact> = {}): Contact {
    const identity = contact[FIELD_ITEM_ID];
    if (typeof identity !== "string") throw new Error("Stored fixture contact has no generated identity.");
    return { [FIELD_ITEM_ID]: identity, ...changes };
  }
  async function events(id: string) {
    return (await sql<{ event_type: string; payload: unknown }>`select event_type, payload
      from platform.entity_events where aggregate_id = ${id} order by sequence`.execute(privileged.db)).rows;
  }
  async function record(contacts: Contact[] = [{ name: "One", private: "contact secret" }]) {
    return createGeneratedEntity(runtime.db, writer, { table: table.name, values: {
      label: "Public record", explicitSecret: "top secret", data: { label: "pii", visible: "old",
        restricted: "nested secret", fixed: "initial", contacts },
    } });
  }

  test("read and list return permitted record content without restricted values", async () => {
    const created = await record();
    const read = await getGeneratedEntity(runtime.db, viewer, { table: table.name, id: String(created.id) });
    expect(read).toMatchObject({ label: "Public record", explicit_secret: null,
      data: { label: null, visible: "old", restricted: null, contacts: [{ name: "One", private: null }] } });
    const listed = await listGeneratedEntities(runtime.db, viewer, { table: table.name, limit: 10 });
    expect(listed.rows.find((row) => row.id === created.id)?.explicit_secret).toBeNull();
    expect(await getGeneratedEntity(runtime.db, { ...viewer, tenantId: randomUUID() }, { table: table.name, id: String(created.id) })).toBeNull();
  });

  test("public JSON edits preserve omitted protected siblings in the database", async () => {
    const created = await record();
    const contact = contactsOf(created)[0]!;
    const updated = await updateGeneratedEntity(runtime.db, editor, { table: table.name, id: String(created.id),
      values: { label: "Changed record", data: { visible: "changed", contacts: [identify(contact, { name: "Renamed" })] } } });
    expect(updated).toMatchObject({ label: "Changed record", explicit_secret: null,
      data: { visible: "changed", restricted: null, fixed: "initial", contacts: [{ name: "Renamed", private: null }] } });
    expect(await stored(String(created.id))).toMatchObject({ explicit_secret: "top secret",
      data: { visible: "changed", restricted: "nested secret", fixed: "initial", contacts: [{ name: "Renamed", private: "contact secret" }] } });
    expect(contactsOf(updated!)[0]?.[FIELD_ITEM_ID]).toBe(contact[FIELD_ITEM_ID]);
  });

  test("unauthorized changes are atomic refusals and do not change stored values or version", async () => {
    const created = await record();
    const initial = await stored(String(created.id));
    for (const values of [{ explicitSecret: "changed" }, { data: { restricted: "nested secret" } }, { label: "wrong", data: { restricted: "changed" } },
      { data: { fixed: "changed" } }, { data: null }, { data: { contacts: [] } }]) {
      await expect(updateGeneratedEntity(runtime.db, editor, { table: table.name, id: String(created.id), values })).rejects.toThrow();
      expect(await stored(String(created.id))).toEqual(initial);
    }
    await expect(updateGeneratedEntity(runtime.db, editor, { table: table.name, id: String(created.id),
      values: { data: { visible: 123 } } })).rejects.toMatchObject({ operationError: { code: "VALIDATION" } });
    expect(await stored(String(created.id))).toEqual(initial);
    await expect(listGeneratedEntities(runtime.db, editor, { table: table.name, filter: { explicitSecret: "probe" } }))
      .rejects.toMatchObject({ operationError: { code: "FORBIDDEN" } });
    await expect(listGeneratedEntities(runtime.db, editor, { table: table.name, sort: { field: "data" } }))
      .rejects.toMatchObject({ operationError: { code: "FORBIDDEN" } });
    const updated = await updateGeneratedEntity(runtime.db, writer, { table: table.name, id: String(created.id),
      values: { explicitSecret: "authorized" } });
    expect(updated?.explicit_secret).toBe("authorized");
  }, 30_000);

  test("reordering and renaming retain each row's protected information and identity", async () => {
    const created = await record([
      { name: "One", private: "secret for One" },
      { name: "Two", private: "secret for Two" },
      { name: "Three", private: "secret for Three" },
    ]);
    const initial = contactsOf(created);
    expect(new Set(initial.map(contact => contact[FIELD_ITEM_ID])).size).toBe(3);
    for (const contact of initial) expect(contact[FIELD_ITEM_ID]).toMatch(/^[0-9a-f-]{36}$/);
    const updated = await updateGeneratedEntity(runtime.db, editor, { table: table.name, id: String(created.id),
      values: { data: { contacts: [identify(initial[1]!, { name: "Two renamed" }), identify(initial[2]!), identify(initial[0]!)] } } });
    expect(contactsOf(updated!)).toEqual([
      { ...initial[1]!, name: "Two renamed", private: null },
      { ...initial[2]!, private: null },
      { ...initial[0]!, private: null },
    ]);
    expect(contactsOf(await stored(String(created.id)))).toEqual([
      { ...initial[1]!, name: "Two renamed" }, initial[2]!, initial[0]!,
    ]);
  });

  test("middle removal of a protected row refuses the entire save even with an unprotected last row", async () => {
    const created = await record([
      { name: "One", private: "secret for One" },
      { name: "Two", private: "secret for Two" },
      { name: "Three" },
    ]);
    const initial = await stored(String(created.id));
    const beforeEvents = await events(String(created.id));
    const contacts = contactsOf(created);
    await expect(updateGeneratedEntity(runtime.db, editor, { table: table.name, id: String(created.id),
      values: { label: "Should not save", data: { contacts: [identify(contacts[0]!), identify(contacts[2]!)] } } }))
      .rejects.toMatchObject({ operationError: { code: "BAD_USER_INPUT" } });
    expect(await stored(String(created.id))).toEqual(initial);
    expect(await events(String(created.id))).toEqual(beforeEvents);
  });

  test("duplicate, unknown and cross-record item identities are atomic refusals", async () => {
    const created = await record([{ name: "One", private: "secret for One" }, { name: "Two", private: "secret for Two" }]);
    const other = await record([{ name: "Other", private: "other record's secret" }]);
    const contacts = contactsOf(created);
    const initial = await stored(String(created.id));
    const otherInitial = await stored(String(other.id));
    const beforeEvents = await events(String(created.id));
    const invalidLists = [
      [identify(contacts[0]!), identify(contacts[0]!)],
      [identify(contacts[0]!), { [FIELD_ITEM_ID]: randomUUID(), name: "Unknown" }],
      [identify(contacts[0]!), identify(contactsOf(other)[0]!, { name: "Spoofed" })],
      [identify(contacts[0]!), { [FIELD_ITEM_ID]: 7, name: "Malformed" }],
    ];
    for (const actor of [editor, writer]) {
      for (const invalid of invalidLists) {
        await expect(updateGeneratedEntity(runtime.db, actor, { table: table.name, id: String(created.id),
          values: { label: "Should not save", data: { contacts: invalid } } }))
          .rejects.toMatchObject({ operationError: { code: "BAD_USER_INPUT" } });
        expect(await stored(String(created.id))).toEqual(initial);
        expect(await events(String(created.id))).toEqual(beforeEvents);
        expect(await stored(String(other.id))).toEqual(otherInitial);
      }
    }
  });

  test("a permitted writer can remove a protected middle row without moving its information to another row", async () => {
    const created = await record([
      { name: "One", private: "secret for One" },
      { name: "Two", private: "secret for Two" },
      { name: "Three", private: "secret for Three" },
    ]);
    const contacts = contactsOf(created);
    const updated = await updateGeneratedEntity(runtime.db, writer, { table: table.name, id: String(created.id),
      values: { data: { contacts: [identify(contacts[2]!, { name: "Third retained" }), identify(contacts[0]!)] } } });
    const expected = [{ ...contacts[2]!, name: "Third retained" }, contacts[0]!];
    expect(contactsOf(updated!)).toEqual(expected);
    expect(contactsOf(await stored(String(created.id)))).toEqual(expected);
  });

  test("new public rows receive fresh identities and remain removable without protected-value permission", async () => {
    const created = await record();
    const original = contactsOf(created)[0]!;
    const added = await updateGeneratedEntity(runtime.db, editor, { table: table.name, id: String(created.id),
      values: { data: { contacts: [identify(original), { name: "New public row" }] } } });
    const contacts = contactsOf(added!);
    expect(contacts[1]?.[FIELD_ITEM_ID]).toMatch(/^[0-9a-f-]{36}$/);
    expect(contacts[1]?.[FIELD_ITEM_ID]).not.toBe(original[FIELD_ITEM_ID]);
    expect(contactsOf(await stored(String(created.id)))).toEqual([original, contacts[1]!]);
    const removed = await updateGeneratedEntity(runtime.db, editor, { table: table.name, id: String(created.id),
      values: { data: { contacts: [identify(original)] } } });
    expect(contactsOf(removed!)).toEqual([{ ...original, private: null }]);
    expect(contactsOf(await stored(String(created.id)))).toEqual([original]);
  });

  test("caller create cannot claim a stored row's identity", async () => {
    const created = await record();
    const beforeCount = (await sql<{ count: number }>`select count(*)::int as count from erp.protected_fields_fixtures`.execute(privileged.db)).rows[0]!.count;
    await expect(createGeneratedEntity(runtime.db, writer, { table: table.name, values: {
      label: "Rejected record", explicitSecret: "secret", data: { visible: "public", restricted: "secret", fixed: "fixed",
        contacts: [identify(contactsOf(created)[0]!, { name: "Spoofed" })] },
    } })).rejects.toMatchObject({ operationError: { code: "BAD_USER_INPUT" } });
    expect((await sql<{ count: number }>`select count(*)::int as count from erp.protected_fields_fixtures`.execute(privileged.db)).rows[0]!.count).toBe(beforeCount);
  });

  test("SQL JSON defaults receive row identities before the create result and its single event", async () => {
    const created = await createGeneratedEntity(runtime.db, editor, { table: table.name, values: { label: "Default record" } });
    const defaults = contactsOf(created);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({ name: "Default", private: null });
    expect(defaults[0]?.[FIELD_ITEM_ID]).toMatch(/^[0-9a-f-]{36}$/);
    expect(contactsOf(await stored(String(created.id)))).toEqual([{ ...defaults[0]!, private: "default contact secret" }]);
    const createdEvents = await events(String(created.id));
    expect(createdEvents.map(event => event.event_type)).toEqual(["created"]);
    const updated = await updateGeneratedEntity(runtime.db, editor, { table: table.name, id: String(created.id),
      values: { data: { contacts: [identify(defaults[0]!, { name: "Default renamed" })] } } });
    expect(contactsOf(updated!)[0]?.[FIELD_ITEM_ID]).toBe(defaults[0]?.[FIELD_ITEM_ID]);
    expect(contactsOf(await stored(String(created.id)))[0]).toMatchObject({ name: "Default renamed", private: "default contact secret" });
  });

  test("trusted object merge preserves hidden siblings, immutable values and collection identities", async () => {
    const created = await record([{ name: "One", private: "secret One" }, { name: "Two", private: "secret Two" }]);
    const initial = await stored(String(created.id));
    const trustedSession = { ...editor, roles: [] };
    const merged = await mergeGeneratedEntityObjectForTable(runtime.db, trustedSession, table, String(created.id), "data", { visible: "runtime" });
    expect(merged).toMatchObject({ explicit_secret: null, data: { label: null, visible: "runtime", restricted: null, fixed: "initial" } });
    expect(contactsOf(merged!)).toEqual(contactsOf(initial).map(contact => ({ ...contact, private: null })));
    expect((await stored(String(created.id))).data).toEqual({ ...(initial.data as object), visible: "runtime" });
    expect((await events(String(created.id))).map(event => event.event_type)).toEqual(["created", "updated"]);
  });

  test("trusted object merge refuses immutable changes without storage, version or event changes", async () => {
    const created = await record();
    const initial = await stored(String(created.id));
    const beforeEvents = await events(String(created.id));
    await expect(mergeGeneratedEntityObjectForTable(runtime.db, { ...editor, roles: [] }, table, String(created.id), "data",
      { visible: "Should not save", fixed: "Changed provenance" }))
      .rejects.toMatchObject({ operationError: { code: "BAD_USER_INPUT" } });
    expect(await stored(String(created.id))).toEqual(initial);
    expect(await events(String(created.id))).toEqual(beforeEvents);
  });

  test("concurrent trusted object merges retain both disjoint public member changes", async () => {
    const created = await record();
    const initial = await stored(String(created.id));
    const trustedSession = { ...editor, roles: [] };
    const merged = await Promise.all([
      mergeGeneratedEntityObjectForTable(runtime.db, trustedSession, table, String(created.id), "data", { visible: "First merge" }),
      mergeGeneratedEntityObjectForTable(runtime.db, trustedSession, table, String(created.id), "data", { otherVisible: "Second merge" }),
    ]);
    expect(merged.every(row => row?.id === created.id)).toBe(true);
    expect((await stored(String(created.id))).data).toEqual({ ...(initial.data as object), visible: "First merge", otherVisible: "Second merge" });
    expect((await events(String(created.id))).map(event => event.event_type)).toEqual(["created", "updated", "updated"]);
  });

  test("trusted object merge preserves an actual encrypted sibling and its ability to decrypt", async () => {
    const keyring = keyringFromEnv(`regression:${Buffer.alloc(32, 7).toString("base64")}`)!;
    const secret = "synthetic encrypted regression token";
    const envelope = storeElicitedValues(table.name,
      [{ key: "token", osfType: "string", classification: { sensitivity: "confidential" } }], { token: secret }, keyring).token;
    const created = await createGeneratedEntity(runtime.db, writer, { table: table.name, values: {
      label: "Encrypted sibling", explicitSecret: "top secret", data: {
        visible: "old", restricted: "nested secret", fixed: "initial", token: envelope,
      },
    } });
    const initial = await stored(String(created.id));
    expect((initial.data as Record<string, unknown>).token).toEqual(envelope);
    const merged = await mergeGeneratedEntityObjectForTable(runtime.db, { ...editor, roles: [] }, table, String(created.id), "data", { visible: "runtime" });
    const saved = (await stored(String(created.id))).data as Record<string, unknown>;
    expect(saved).toEqual({ ...(initial.data as object), visible: "runtime" });
    expect(saved.token).toEqual(envelope);
    expect(decryptSecret(keyring, table.name, "token", saved.token as import("../../connectors/secrets.js").StoredSecret)).toBe(secret);
    expect((merged!.data as Record<string, unknown>).token).toBeNull();
    expect(JSON.stringify(merged)).not.toContain("ciphertext");
  });

  test("actual secure form POST preserves omitted encrypted siblings and denies cross-tenant access", async () => {
    const { registerConfigurationHandoffRoutes } = await import("../../mcp/configuration-handoff-routes.js");
    const { mintConfiguration } = await import("../../mcp/configuration-handoff.js");
    const keyringText = `handoff:${Buffer.alloc(32, 11).toString("base64")}`;
    const keyring = keyringFromEnv(keyringText)!;
    const secret = "synthetic secure form regression token";
    const token = storeElicitedValues(table.name,
      [{ key: "token", osfType: "string", classification: { sensitivity: "confidential" } }], { token: secret }, keyring).token;
    const key = `config-${randomUUID()}`;
    const definitionId = randomUUID();
    const acceptanceId = randomUUID();
    const created = await createGeneratedEntity(runtime.db, writer, { table: table.name, values: {
      key, definitionId, acceptanceId, label: "Secure rotation", explicitSecret: "top secret", data: { visible: "old", restricted: "nested secret", fixed: "initial", token },
    } });
    const previousSecure = table.source!.secureInputOnCreate;
    const previousKeyring = process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;
    table.source!.secureInputOnCreate = { sourceField: "definitionId", sourceEntity: "Fixture", definitionsField: "definitions", into: "data" };
    process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS = keyringText;
    try {
      const routes = new Map<string, (...args: any[]) => Promise<unknown>>();
      await registerConfigurationHandoffRoutes({
        instance: { addContentTypeParser() {}, get() {}, post: (path: string, handler: (...args: any[]) => Promise<unknown>) => routes.set(path, handler) },
        options: { db: runtime.db }, requireMcpSession: async () => ({ db: runtime.db, session: writer, resource: "fixture" }),
      } as never);
      const post = routes.get("/api/entity-configuration/:token")!;
      const mint = async (tenantId: string, overrides: Record<string, unknown> = {}) => {
        const pending = await mintConfiguration({ db: runtime.db, tenantId, userId: writer.userId, table: table.name,
          elicit: { sourceField: "definitionId", sourceEntity: "Fixture", sourceTable: table.name, definitionsField: "definitions", into: "data" },
          modelValues: { key, definitionId, acceptanceId, ...overrides }, displayName: "Fixture", definitions: [
            { key: "visible", osfType: "string", required: true, label: { en: "Public value" } },
            { key: "token", osfType: "string", label: { en: "Secret value" }, classification: { sensitivity: "confidential" } },
          ],
        });
        return pending;
      };
      const submitPending = async (pending: { token: string }, body: string, authenticatedId?: string) => {
        let status = 200;
        let output: unknown;
        const reply = { status(code: number) { status = code; return this; }, type() { return this; }, send(value: unknown) { output = value; return this; } };
        const handler = authenticatedId ? routes.get("/api/entity-configuration/pending/:id")! : post;
        try { await handler({ params: { token: pending.token, id: authenticatedId }, body, log: { error() {} } }, reply); }
        catch (error) { status = (error as { status?: number }).status ?? 500; }
        return { status, output };
      };
      const submit = async (tenantId: string, body: string, overrides: Record<string, unknown> = {}) => submitPending(await mint(tenantId, overrides), body);
      const before = (await stored(String(created.id))).data as Record<string, unknown>;
      expect((await submit(writer.tenantId, "visible=changed")).status).toBe(200);
      const saved = (await stored(String(created.id))).data as Record<string, unknown>;
      expect(saved.token).toEqual(before.token);
      expect(saved.visible).toBe("changed");
      expect(decryptSecret(keyring, table.name, "token", saved.token as import("../../connectors/secrets.js").StoredSecret)).toBe(secret);
      const read = await getGeneratedEntity(runtime.db, writer, { table: table.name, id: String(created.id) });
      expect(JSON.stringify(read)).not.toContain(secret);
      expect(JSON.stringify(read)).not.toContain("ciphertext");
      expect((read!.data as Record<string, unknown>).token).toBe("__set__");
      const beforeDenied = await stored(String(created.id));
      expect((await submit(randomUUID(), "visible=wrong-tenant")).status).toBe(400);
      expect(await stored(String(created.id))).toEqual(beforeDenied);
      expect(JSON.stringify(await events(String(created.id)))).not.toContain(secret);
      for (const overrides of [{ definitionId: randomUUID() }, { acceptanceId: randomUUID() }, { definitionId: undefined }, { acceptanceId: undefined }]) {
        const beforeMismatch = await stored(String(created.id));
        const beforeMismatchEvents = await events(String(created.id));
        expect((await submit(writer.tenantId, "visible=changed&token=must-not-rebind", overrides)).status).toBe(400);
        expect(await stored(String(created.id))).toEqual(beforeMismatch);
        expect(await events(String(created.id))).toEqual(beforeMismatchEvents);
      }
      // One pending form is one transaction: a second parallel authenticated
      // POST must lose before it can change either storage or event history.
      const { latestConfigurationForSession } = await import("../../mcp/configuration-handoff.js");
      const parallelPending = await mint(writer.tenantId);
      const parallelId = (await latestConfigurationForSession(writer, runtime.db))!.id;
      const beforeParallelEvents = await events(String(created.id));
      const parallel = await Promise.all([
        submitPending(parallelPending, "visible=first", parallelId),
        submitPending(parallelPending, "visible=second", parallelId),
      ]);
      expect(parallel.map(response => response.status).sort()).toEqual([200, 409]);
      expect((await events(String(created.id))).length).toBe(beforeParallelEvents.length + 1);
      const tokenPending = await mint(writer.tenantId);
      const beforeTokenEvents = await events(String(created.id));
      const tokenParallel = await Promise.all([
        submitPending(tokenPending, "visible=token-first"), submitPending(tokenPending, "visible=token-second"),
      ]);
      expect(tokenParallel.map(response => response.status).sort()).toEqual([200, 400]);
      expect((await events(String(created.id))).length).toBe(beforeTokenEvents.length + 1);
      // A failed write rolls back consumption, leaving the same form retryable.
      const retryPending = await mint(writer.tenantId, { label: "Different identity" });
      expect((await submitPending(retryPending, "visible=must-not-save")).status).toBe(400);
      const { peekConfiguration } = await import("../../mcp/configuration-handoff.js");
      expect(await peekConfiguration(retryPending.token, runtime.db)).not.toBeNull();
      const validationPending = await mint(writer.tenantId);
      const validationId = (await latestConfigurationForSession(writer, runtime.db))!.id;
      const beforeValidation = await stored(String(created.id));
      expect((await submitPending(validationPending, "visible=", validationId)).status).not.toBe(200);
      expect(await stored(String(created.id))).toEqual(beforeValidation);
      expect(await peekConfiguration(validationPending.token, runtime.db)).not.toBeNull();
      expect((await submitPending(validationPending, "visible=retry", validationId)).status).toBe(200);
      // The same single-use rule protects a brand-new row even when its table
      // does not have a key uniqueness constraint to mask duplicate creates.
      const createKey = `create-${randomUUID()}`;
      const createPending = await mintConfiguration({ db: runtime.db, tenantId: writer.tenantId, userId: writer.userId, table: table.name,
        elicit: { sourceField: "definitionId", sourceEntity: "Fixture", sourceTable: table.name, definitionsField: "definitions", into: "data" },
        modelValues: { key: createKey, definitionId, acceptanceId, label: "Created once", explicitSecret: "not a credential" }, displayName: "Fixture", definitions: [
          { key: "visible", osfType: "string", required: true }, { key: "restricted", osfType: "string", required: true }, { key: "fixed", osfType: "string", required: true },
          { key: "token", osfType: "string", classification: { sensitivity: "confidential" } },
        ],
      });
      const createId = (await latestConfigurationForSession(writer, runtime.db))!.id;
      const creations = await Promise.all([
        submitPending(createPending, "visible=new&restricted=private&fixed=initial&token=first", createId),
        submitPending(createPending, "visible=new&restricted=private&fixed=initial&token=second", createId),
      ]);
      expect(creations.map(response => response.status).sort()).toEqual([200, 409]);
      const createdRows = await listGeneratedEntities(runtime.db, writer, { table: table.name, filter: { key: createKey } });
      expect(createdRows.rows).toHaveLength(1);
      expect(await events(String(createdRows.rows[0]!.id))).toHaveLength(1);
    } finally {
      if (previousSecure === undefined) delete table.source!.secureInputOnCreate; else table.source!.secureInputOnCreate = previousSecure;
      if (previousKeyring === undefined) delete process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS; else process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS = previousKeyring;
    }
  }, 30_000);

  test("browser secure initiation uses canonical admission and tenant-bound definitions", async () => {
    const { startConfigurationForSession } = await import("../../mcp/configuration-start.js");
    const { latestConfigurationForSession, consumeConfigurationForSession } = await import("../../mcp/configuration-handoff.js");
    const previous = process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;
    process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS = `browser:${Buffer.alloc(32, 12).toString("base64")}`;
    try {
      const definition = await createGeneratedEntity(runtime.db, writer, { table: table.name, values: {
        key: `definition-${randomUUID()}`, label: "Secure definition", explicitSecret: "not a credential",
        data: { visible: "source", restricted: "private", fixed: "initial" },
        definitions: [{ key: "token", osfType: "string", classification: { sensitivity: "confidential" } }],
      } });
      const body = { entity: "ProtectedFieldsFixture", values: { key: `browser-${randomUUID()}`, label: "Browser configuration", explicitSecret: "not a credential", definitionId: definition.id } };
      const admitted = await startConfigurationForSession(runtime.db, writer, body);
      expect(admitted).toEqual({ id: expect.any(String), expiresInSeconds: 1800 });
      expect(JSON.stringify(admitted)).not.toContain("token");
      const pending = await latestConfigurationForSession(writer, runtime.db);
      expect(pending!.id).toBe(admitted.id);
      expect(pending!.pending.modelValues).toEqual(body.values);
      expect(pending!.pending.definitions).toMatchObject([{ key: "token", osfType: "string" }]);
      expect(await latestConfigurationForSession({ ...writer, userId: randomUUID() }, runtime.db)).toBeNull();
      expect(await latestConfigurationForSession({ ...writer, tenantId: randomUUID() }, runtime.db)).toBeNull();
      expect(await consumeConfigurationForSession(pending!.id, { ...writer, tenantId: randomUUID() }, runtime.db)).toBe(false);
      expect(await consumeConfigurationForSession(pending!.id, writer, runtime.db)).toBe(true);
      await expect(startConfigurationForSession(runtime.db, viewer, body)).rejects.toBeDefined();
      await expect(startConfigurationForSession(runtime.db, { ...writer, tenantId: randomUUID() }, body)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(startConfigurationForSession(runtime.db, writer, { ...body, values: { ...body.values, data: { token: "must not be accepted" } } })).rejects.toBeDefined();
      await expect(startConfigurationForSession(runtime.db, writer, { ...body, tenantId: writer.tenantId })).rejects.toMatchObject({ code: "BAD_USER_INPUT" });
    } finally {
      if (previous === undefined) delete process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS; else process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS = previous;
    }
  }, 30_000);

  test("trusted object merge ignores undefined members without changing storage, version or events", async () => {
    const created = await record();
    const trustedSession = { ...editor, roles: [] };
    await mergeGeneratedEntityObjectForTable(runtime.db, trustedSession, table, String(created.id), "data", { otherVisible: "retained" });
    const initial = await stored(String(created.id));
    const beforeEvents = await events(String(created.id));
    const merged = await mergeGeneratedEntityObjectForTable(runtime.db, trustedSession, table, String(created.id), "data",
      { visible: undefined, fixed: undefined, otherVisible: undefined });
    expect(await stored(String(created.id))).toEqual(initial);
    expect(await events(String(created.id))).toEqual(beforeEvents);
    expect(merged).toMatchObject({ explicit_secret: null,
      data: { label: null, visible: "old", restricted: null, fixed: "initial", otherVisible: "retained" } });
    expect(contactsOf(merged!)).toEqual(contactsOf(initial).map(contact => ({ ...contact, private: null })));
  });
}
