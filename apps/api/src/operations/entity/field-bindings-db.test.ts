// SPDX-License-Identifier: BUSL-1.1
/**
 * The typed-variable runtime against a real database, through the canonical
 * Operations only.
 *
 * Two real entities carry it: Chip is the tenant's global variable, whose
 * value is typed by the FieldDefinition stored beside it, and LabelRule has a
 * persisted field that accepts a variable (`descriptionTemplate`), so it is
 * the destination a binding is stored on. Everything here goes through
 * `executeEntityOperation`, so what is proven is the shared path every
 * interface uses — not a helper.
 *
 * Scratch database on the task's own Postgres (docs/testing.md, "Migration
 * tests"); the shared development database is never touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { withDbSession } from "../../db/session.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { resolveComputedEntityRows } from "./computed-fields.js";
import { executeEntityOperation } from "./runtime.js";
import type { EntityOperationInput, EntityOperationResult, GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const database = `field_bindings_${randomUUID().replaceAll("-", "")}`;
const tenant = randomUUID();
const neighbourTenant = randomUUID();
/** Chip writes need Organization.All.ReadWrite; LabelRule writes General.All.ReadWrite. */
const editor = {
  tenantId: tenant,
  userId: randomUUID(),
  roles: ["Organization.All.ReadWrite", "General.All.ReadWrite"],
  groups: [],
  scope: "tenant" as const,
};
/** Reads both entities, writes neither global. */
const viewer = { ...editor, roles: ["General.All.Read"] };
const neighbour = { ...editor, tenantId: neighbourTenant };

let admin: SQL;
let privileged: DatabaseRuntime;
let runtime: DatabaseRuntime;

type Session = typeof editor;

const intentOf = (id: string) => id.split(".")[1] as "list" | "get" | "create" | "update" | "delete";

function run(session: Session, id: string, input: EntityOperationInput): Promise<EntityOperationResult> {
  return executeEntityOperation(runtime.db, session, {
    operation: { id, intent: intentOf(id) },
    input,
  });
}

/** The record of a successful result, or a failure that names what went wrong. */
function record(result: EntityOperationResult): GeneratedEntityRow {
  if ("error" in result) throw new Error(`${result.intent} failed: ${JSON.stringify(result.error)}`);
  if (result.intent === "list" || result.intent === "delete" || !result.data) {
    throw new Error(`${result.intent} returned no record.`);
  }
  return result.data;
}

const failure = (result: EntityOperationResult) =>
  "error" in result ? result.error : undefined;

/** The concurrency token LabelRule.update and Chip.delete require. */
async function version(table: string, id: string): Promise<string> {
  const rows = await sql<{ version: string }>`
    select updated_at::text as version from ${sql.id("erp", table)} where id = ${id}::uuid
  `.execute(privileged.db);
  return String(rows.rows[0]!.version);
}

const text = (overrides: Record<string, unknown> = {}) =>
  ({ key: "value", osfType: "multilineText", required: true, validation: { maxLength: 8000 }, ...overrides });

/** A tenant global, created through Chip.create. */
async function tenantGlobal(
  session: Session,
  key: string,
  definition: Record<string, unknown>,
  value: unknown,
): Promise<GeneratedEntityRow> {
  return record(await run(session, "Chip.create", {
    values: { key, name: key, definition, value, isActive: true },
  }));
}

/** A destination record, created through LabelRule.create. */
async function memo(
  session: Session,
  overrides: { values?: Record<string, unknown>; bindings?: unknown; unbind?: unknown } = {},
): Promise<EntityOperationResult> {
  const key = `k${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return run(session, "LabelRule.create", {
    values: {
      name: `Rule ${key}`,
      entityType: "Relation",
      label: "Attention",
      variant: "default",
      key,
      outputType: "string",
      expression: {},
      priority: 0,
      active: true,
      validity: "permanent",
      ...overrides.values,
    },
    ...(overrides.bindings !== undefined ? { bindings: overrides.bindings } : {}),
    ...(overrides.unbind !== undefined ? { unbind: overrides.unbind } : {}),
  });
}

async function updateMemo(
  session: Session,
  id: string,
  input: { values?: Record<string, unknown>; bindings?: unknown; unbind?: unknown },
): Promise<EntityOperationResult> {
  return run(session, "LabelRule.update", {
    id,
    expectedVersion: await version("label_rules", id),
    values: input.values ?? {},
    ...(input.bindings !== undefined ? { bindings: input.bindings } : {}),
    ...(input.unbind !== undefined ? { unbind: input.unbind } : {}),
  });
}

const read = async (session: Session, id: string) => run(session, "LabelRule.get", { id });

beforeAll(async () => {
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") {
    throw new Error("Scratch tests require a local postgres admin database, never an application database.");
  }
  admin = new SQL(adminUrl, { max: 1 });
  await admin.unsafe(`create database "${database}"`);
  url.pathname = `/${database}`;
  privileged = createDatabaseRuntime({ databaseUrl: url.toString() });
  await privileged.db.connection().execute((connection) => runMigrationChain(connection));
  url.username = "openshapeforge_app";
  url.password = "openshapeforge_app";
  runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 4 });
}, 180_000);

afterAll(async () => {
  await runtime?.close();
  await privileged?.close();
  await admin?.unsafe(`drop database if exists "${database}" with (force)`);
  await admin?.close();
});

describe("a typed global value, stored and read back", () => {
  test("every value its own definition permits is stored and returned unchanged", async () => {
    const stored = async (key: string, definition: Record<string, unknown>, value: unknown) => {
      const created = await tenantGlobal(editor, key, definition, value);
      const got = record(await run(editor, "Chip.get", { id: String(created.id) }));
      return got.value;
    };
    // Exact decimal text is the form every numeric value is projected in, and
    // it comes back with every digit.
    expect(await stored("rate.exact", { key: "value", osfType: "currency", required: true }, "12.50")).toBe("12.50");
    expect(await stored("rate.big", { key: "value", osfType: "currency", required: true }, "9007199254740993.01"))
      .toBe("9007199254740993.01");
    // The JSON number form of the same type is equally acceptable.
    expect(await stored("rate.number", { key: "value", osfType: "currency", required: true }, 12.5)).toBe(12.5);
    // false, zero, an empty text and an empty collection are values.
    expect(await stored("flag.off", { key: "value", osfType: "boolean", required: true }, false)).toBe(false);
    expect(await stored("count.zero", { key: "value", osfType: "integer", required: true }, 0)).toBe(0);
    expect(await stored("note.empty", { key: "value", osfType: "string" }, "")).toBe("");
    expect(await stored("tags.none", { key: "value", osfType: "string", cardinality: { min: 0, max: 8 }, item: { key: "item", osfType: "string" } }, []))
      .toEqual([]);
    // A null is permitted only where the definition and the column permit it;
    // Chip.value is NOT NULL, so it is refused rather than stored.
    expect(failure(await run(editor, "Chip.create", {
      values: { key: "note.null", name: "note.null", definition: text({ required: false }), value: null, isActive: true },
    }))).toMatchObject({ code: "VALIDATION", violations: [{ field: "value", code: "REQUIRED" }] });
  });

  test("a value or a definition the pair does not permit is refused, and nothing is stored", async () => {
    const refused = async (definition: unknown, value: unknown) => failure(await run(editor, "Chip.create", {
      values: { key: `bad.${randomUUID().slice(0, 8)}`, name: "bad", definition, value, isActive: true },
    }));
    expect(await refused(text(), 12)).toMatchObject({ code: "VALIDATION" });
    expect(await refused(text({ validation: { minLength: 1 } }), "")).toMatchObject({ code: "VALIDATION" });
    expect(await refused({ ...text(), key: "amount" }, "x"))
      .toMatchObject({ code: "VALIDATION", violations: [{ field: "definition" }] });
    expect(await refused({ key: "value" }, "x")).toMatchObject({ code: "VALIDATION" });
    // A definition carrying policy this runtime cannot enforce inside one
    // json column — here inherited from the `email` osf type, which is pii —
    // is refused rather than stored unprotected.
    expect(await refused({ key: "value", osfType: "email", required: true }, "someone@example.test"))
      .toMatchObject({ code: "BAD_USER_INPUT" });
    // And so is an entity reference, whose target would need a real
    // authorized read that a value in a json column never gets.
    expect(await refused({ key: "value", osfType: "Relation", required: true }, randomUUID()))
      .toMatchObject({ code: "BAD_USER_INPUT" });
    const listed = await run(editor, "Chip.list", { filter: { name: "bad" } });
    if (listed.intent !== "list" || "error" in listed) throw new Error("list failed");
    expect(listed.data.items).toEqual([]);
  });

  test("an update of either half keeps the pair valid", async () => {
    const chip = await tenantGlobal(editor, "hours.rate", { key: "value", osfType: "currency", required: true }, "80.00");
    const id = String(chip.id);
    // The value alone, against the stored definition.
    expect(record(await run(editor, "Chip.update", { id, values: { value: "95.00" } })).value).toBe("95.00");
    expect(failure(await run(editor, "Chip.update", { id, values: { value: "ninety" } })))
      .toMatchObject({ code: "VALIDATION" });
    // A definition alone that the stored value does not satisfy is refused:
    // the record would otherwise hold a value of neither type.
    expect(failure(await run(editor, "Chip.update", { id, values: { definition: { key: "value", osfType: "boolean", required: true } } })))
      .toMatchObject({ code: "VALIDATION" });
    expect(record(await run(editor, "Chip.get", { id })).value).toBe("95.00");
    // Both halves together is how a global is retyped.
    const retyped = record(await run(editor, "Chip.update", {
      id, values: { definition: { key: "value", osfType: "boolean", required: true }, value: true },
    }));
    expect(retyped.value).toBe(true);
  });

  test("writing a global needs the role its own Operation declares", async () => {
    expect(failure(await run(viewer, "Chip.create", {
      values: { key: "denied.key", name: "denied", definition: text(), value: "x", isActive: true },
    }))).toMatchObject({ code: "FORBIDDEN" });
    // The same actor reads it: the gate is the Operation's, not the entity's.
    const chip = await tenantGlobal(editor, "read.only", text(), "Readable");
    expect(record(await run(viewer, "Chip.get", { id: String(chip.id) })).value).toBe("Readable");
  });

  test("get and list refuse an already-stored protected typed definition without returning its value", async () => {
    const chip = await tenantGlobal(editor, "invalid.stored.type", text(), "Secret fixture value");
    await sql`update erp.chips set definition = ${{ key: "value", osfType: "email", required: true }}
      where id = ${String(chip.id)}::uuid`.execute(privileged.db);
    for (const result of [
      await run(viewer, "Chip.get", { id: String(chip.id) }),
      await run(viewer, "Chip.list", { filter: { key: "invalid.stored.type" } }),
    ]) {
      expect(failure(result)).toMatchObject({ code: "INVALID_DEFINITION" });
      expect(JSON.stringify(result)).not.toContain("Secret fixture value");
    }
    // Restore the fixture so unrelated list journeys keep a valid corpus.
    await sql`update erp.chips set definition = ${text()} where id = ${String(chip.id)}::uuid`.execute(privileged.db);
  });
});

describe("a binding, stored apart from the value it resolved to", () => {
  test("the binding and the resolved value are both persisted, and the source is live", async () => {
    const chip = await tenantGlobal(editor, "support.phone", text(), "020-1234567");
    const created = record(await memo(editor, {
      bindings: { descriptionTemplate: { template: "Bel {{chips.support.phone}} voor uitleg" } },
    }));
    const id = String(created.id);
    // The resolved value is in the column, the author's intent beside it.
    expect(created.description_template).toBe("Bel 020-1234567 voor uitleg");
    expect(created.field_bindings).toEqual({
      descriptionTemplate: { kind: "template", source: "Bel {{chips.support.phone}} voor uitleg" },
    });
    // A later change of the source is visible on the next read, while the
    // binding itself is untouched.
    await run(editor, "Chip.update", { id: String(chip.id), values: { value: "020-7654321" } });
    const reread = record(await read(editor, id));
    expect(reread.description_template).toBe("Bel 020-7654321 voor uitleg");
    expect(reread.field_bindings).toEqual(created.field_bindings);
    // And on a list, where the page resolves each variable once.
    const listed = await run(editor, "LabelRule.list", { filter: { key: String(created.key) } });
    if (listed.intent !== "list" || "error" in listed) throw new Error("list failed");
    expect(listed.data.items[0]!.data.description_template).toBe("Bel 020-7654321 voor uitleg");
  });

  test("computed labels resolve current variables without reinterpreting source text", async () => {
    const chip = await tenantGlobal(editor, "live.label", text(), "Old");
    const rule = record(await memo(editor, {
      values: { expression: { kind: "literal", value: "visible" } },
      bindings: { descriptionTemplate: { template: "Message: {{chips.live.label}}" } },
    }));
    await run(editor, "Chip.update", { id: String(chip.id), values: { value: "New {{displayName}}" } });
    const table = { source: { authoringEntityName: "Relation", computedFields: [{ field: "labels", resolver: "labelRules" }] }, columns: [] } as unknown as GeneratedCrudTable;
    const rows = await withDbSession(runtime.db, editor, (trx, session) =>
      resolveComputedEntityRows(trx, session, table, [{ display_name: "private" }]));
    const labels = rows[0]!.labels as { items: { id: string; description: string }[] };
    expect(labels.items.find(item => item.id === rule.id)?.description).toBe("Message: New {{displayName}}");
    const chipValue = getGeneratedCrudTables().find(t => t.table === "chips")!.columns.find(c => c.name === "value")!;
    const priorClassification = chipValue.classification;
    try {
      chipValue.classification = "confidential";
      const withheld = await withDbSession(runtime.db, viewer, (trx, session) =>
        resolveComputedEntityRows(trx, session, table, [{ display_name: "kept" }]));
      expect(withheld[0]!.display_name).toBe("kept");
      expect((withheld[0]!.labels as typeof labels).items.some(item => item.id === rule.id)).toBe(false);
      expect(JSON.stringify(withheld)).not.toContain("New {{displayName}}");
    } finally {
      if (priorClassification === undefined) delete chipValue.classification;
      else chipValue.classification = priorClassification;
    }
    await run(editor, "Chip.delete", { id: String(chip.id), expectedVersion: await version("chips", String(chip.id)), confirmed: true });
    const removed = await withDbSession(runtime.db, editor, (trx, session) =>
      resolveComputedEntityRows(trx, session, table, [{ display_name: "kept" }]));
    expect(removed[0]!.display_name).toBe("kept");
    expect((removed[0]!.labels as typeof labels).items.some(item => item.id === rule.id)).toBe(false);
    expect(failure(await read(editor, String(rule.id)))).toMatchObject({ code: "DEPENDENCY_UNRESOLVED" });
    // Keep the intentionally broken source isolated from the following list tests.
    await sql`delete from erp.label_rules where id = ${String(rule.id)}::uuid`.execute(privileged.db);
  });

  test("a local binding reads another field of the same record", async () => {
    const created = record(await memo(editor, {
      values: { label: "Arrears" },
      bindings: { descriptionTemplate: { template: "Label: {{local.label}}" } },
    }));
    expect(created.description_template).toBe("Label: Arrears");
    const updated = record(await updateMemo(editor, String(created.id), { values: { label: "Paid" } }));
    // The local source changed in this very write, so the bound field is
    // resolved against what the record will hold, not what it held.
    expect(updated.description_template).toBe("Label: Paid");
    expect(record(await read(editor, String(created.id))).description_template).toBe("Label: Paid");
  });

  test("a literal clears the binding, and an unbind freezes the value the source has NOW", async () => {
    const chip = await tenantGlobal(editor, "office.hours", text(), "09:00-17:00");
    const bound = record(await memo(editor, {
      bindings: { descriptionTemplate: { template: "Open {{chips.office.hours}}" } },
    }));
    const id = String(bound.id);
    // A literal replaces the binding: the field stops following its source.
    const literal = record(await updateMemo(editor, id, { values: { descriptionTemplate: "Open on request" } }));
    expect(literal.description_template).toBe("Open on request");
    expect(literal.field_bindings).toBeNull();
    await run(editor, "Chip.update", { id: String(chip.id), values: { value: "08:00-18:00" } });
    expect(record(await read(editor, id)).description_template).toBe("Open on request");

    // Bind again, change the source, then unbind: what is frozen is the
    // value the source has now, never the column's stale content.
    const rebound = record(await updateMemo(editor, id, {
      bindings: { descriptionTemplate: { template: "Open {{chips.office.hours}}" } },
    }));
    expect(rebound.description_template).toBe("Open 08:00-18:00");
    await run(editor, "Chip.update", { id: String(chip.id), values: { value: "10:00-16:00" } });
    const frozen = record(await updateMemo(editor, id, { unbind: ["descriptionTemplate"] }));
    expect(frozen.description_template).toBe("Open 10:00-16:00");
    expect(frozen.field_bindings).toBeNull();
    await run(editor, "Chip.update", { id: String(chip.id), values: { value: "unused" } });
    expect(record(await read(editor, id)).description_template).toBe("Open 10:00-16:00");
  });

  test("the bindings map is never a value a caller may write", async () => {
    expect(failure(await memo(editor, { values: { fieldBindings: { descriptionTemplate: { kind: "whole", ref: "chips.x" } } } })))
      .toMatchObject({ code: "BAD_USER_INPUT" });
    expect(failure(await memo(editor, { values: { field_bindings: {} } })))
      .toMatchObject({ code: "BAD_USER_INPUT" });
  });

  test("a bound field is not a filter, a sort or a membership oracle", async () => {
    for (const input of [
      { filter: { descriptionTemplate: "Bel" } },
      { filter: { descriptionTemplateIn: ["Bel"] } },
      { filter: { fieldBindings: "x" } },
      { sort: { field: "descriptionTemplate", direction: "asc" } },
    ] satisfies EntityOperationInput[]) {
      expect(failure(await run(editor, "LabelRule.list", input))).toMatchObject({ code: "BAD_USER_INPUT" });
    }
    // The fields that take literals only are unaffected.
    const byName = await run(editor, "LabelRule.list", { sort: { field: "name", direction: "asc" } });
    expect(failure(byName)).toBeUndefined();
  });
});

describe("what a binding is refused for", () => {
  test("a later valid source update cannot violate the destination's bounds on a live read", async () => {
    const chip = await tenantGlobal(editor, "bounded.note", text(), "Small");
    const bound = record(await memo(editor, { bindings: { descriptionTemplate: { template: "{{chips.bounded.note}}" } } }));
    await run(editor, "Chip.update", { id: String(chip.id), values: { value: "x".repeat(2500) } });
    expect(failure(await read(editor, String(bound.id)))).toMatchObject({ code: "DEPENDENCY_INVALID" });
    await run(editor, "Chip.update", { id: String(chip.id), values: { value: "Small again" } });
    expect(record(await read(editor, String(bound.id))).description_template).toBe("Small again");
  });

  test("a bounded token count cannot amplify source text into an oversized result", async () => {
    await tenantGlobal(editor, "large.note", text(), "x".repeat(8000));
    const result = await memo(editor, { bindings: { descriptionTemplate: { template: "{{chips.large.note}}".repeat(26) } } });
    expect(failure(result)).toMatchObject({ code: "VALIDATION", violations: [{ code: "BINDING_TOO_LARGE" }] });
  });
  test("a source that does not exist, does not fit, or is a different tenant's", async () => {
    // Nothing of that name in this organization.
    expect(failure(await memo(editor, { bindings: { descriptionTemplate: { template: "{{chips.absent.key}}" } } })))
      .toMatchObject({ code: "VALIDATION", violations: [{ field: "descriptionTemplate", code: "UNKNOWN_VARIABLE" }] });
    // A collection and an object are not text a template can splice in.
    await tenantGlobal(editor, "team.members", { key: "value", osfType: "string", cardinality: { min: 0, max: 8 }, item: { key: "item", osfType: "string" } }, ["Ada", "Alan"]);
    expect(failure(await memo(editor, { bindings: { descriptionTemplate: { template: "Team: {{chips.team.members}}" } } })))
      .toMatchObject({ code: "VALIDATION", violations: [{ field: "descriptionTemplate", code: "INCOMPATIBLE_CARDINALITY" }] });
    await tenantGlobal(editor, "office.address",
      { key: "value", osfType: "object", required: true, children: [{ key: "street", osfType: "string", required: true }] },
      { street: "Dam 1" });
    expect(failure(await memo(editor, { bindings: { descriptionTemplate: { template: "At {{chips.office.address}}" } } })))
      .toMatchObject({ code: "VALIDATION", violations: [{ field: "descriptionTemplate" }] });
    // A field that accepts no variable, and a shape its mode does not admit.
    expect(failure(await memo(editor, { bindings: { label: "chips.team.members" } })))
      .toMatchObject({ code: "BAD_USER_INPUT" });
    expect(failure(await memo(editor, { bindings: { descriptionTemplate: "chips.office.address" } })))
      .toMatchObject({ code: "BAD_USER_INPUT" });
    // A binding that resolves through itself.
    expect(failure(await memo(editor, { bindings: { descriptionTemplate: { template: "{{local.descriptionTemplate}}" } } })))
      .toMatchObject({ code: "VALIDATION", violations: [{ field: "descriptionTemplate", code: "BINDING_CYCLE" }] });
    // Another tenant's global is not available here, and the same key in two
    // organizations is two variables.
    expect(failure(await memo(neighbour, { bindings: { descriptionTemplate: { template: "{{chips.support.phone}}" } } })))
      .toMatchObject({ code: "VALIDATION", violations: [{ code: "UNKNOWN_VARIABLE" }] });
    await tenantGlobal(neighbour, "support.phone", text(), "030-0000000");
    const theirs = record(await memo(neighbour, {
      bindings: { descriptionTemplate: { template: "Bel {{chips.support.phone}}" } },
    }));
    expect(theirs.description_template).toBe("Bel 030-0000000");
    // Their record is not this tenant's to read at all, bound field included:
    // either the read refuses it or it is simply not there.
    const foreign = await read(editor, String(theirs.id));
    expect(("error" in foreign ? undefined : foreign.data) ?? null).toBeNull();
  });

  test("a source that stops fitting, or goes away, refuses the READ instead of answering stale", async () => {
    const chip = await tenantGlobal(editor, "closing.note", text(), "Tot ziens");
    const bound = record(await memo(editor, {
      bindings: { descriptionTemplate: { template: "Slot: {{chips.closing.note}}" } },
    }));
    const id = String(bound.id);
    expect(record(await read(editor, id)).description_template).toBe("Slot: Tot ziens");
    // Retyped as a collection, which no template can hold: the read refuses
    // rather than returning the value of the last write.
    await run(editor, "Chip.update", {
      id: String(chip.id),
      values: { definition: { key: "value", osfType: "string", cardinality: { min: 0, max: 4 }, item: { key: "item", osfType: "string" } }, value: ["Tot ziens"] },
    });
    expect(failure(await read(editor, id))).toMatchObject({ code: "DEPENDENCY_INVALID" });
    expect(failure(await run(editor, "LabelRule.list", { filter: { key: String(bound.key) } })))
      .toMatchObject({ code: "DEPENDENCY_INVALID" });
    // And when the source is gone, the read says the dependency is missing.
    const deleted = await run(editor, "Chip.delete", {
      id: String(chip.id),
      expectedVersion: await version("chips", String(chip.id)),
      confirmed: true,
    });
    expect(failure(deleted)).toBeUndefined();
    expect(failure(await read(editor, id))).toMatchObject({ code: "DEPENDENCY_UNRESOLVED" });
    // The binding is still on the record: the refusal is about its source.
    const row = await sql<{ bindings: unknown }>`
      select field_bindings as bindings from erp.label_rules where id = ${id}::uuid
    `.execute(privileged.db);
    expect(row.rows[0]!.bindings).toEqual({
      descriptionTemplate: { kind: "template", source: "Slot: {{chips.closing.note}}" },
    });
  });
});
