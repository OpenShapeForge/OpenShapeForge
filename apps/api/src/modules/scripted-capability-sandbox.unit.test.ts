// SPDX-License-Identifier: BUSL-1.1
// The host bridge between a trusted installed module and the sandbox daemon.
// Runs the real daemon and worker over a real ephemeral Unix socket, so a
// brokered read crosses the actual protocol rather than a stub. Tests that must
// prove a refusal happens BEFORE the run start no daemon at all: the refusal
// code then distinguishes a guard from a transport failure.
//
// The page tests use synthetic journal data invented here. They are sized to
// cross the single-frame budget in both directions, so a whole-page transfer is
// exercised end to end rather than asserted from the limits alone.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeScriptedCapabilityBinding } from "@openshapeforge/plugin-runtime";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { startSandboxDaemon, type SandboxDaemon } from "../script-sandbox/daemon.js";
import { createScriptedCapabilitySandbox } from "./scripted-capability-sandbox.js";

const PILOT_TENANT = "11111111-2222-3333-4444-555555555555";
const OTHER_TENANT = "99999999-8888-7777-6666-555555555555";

let dir: string;
let socketPath: string;
let daemon: SandboxDaemon | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "osf-sbx-bridge-"));
  socketPath = join(dir, "s.sock");
});
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await rm(dir, { recursive: true, force: true });
});

const start = async () => { daemon = await startSandboxDaemon({ socketPath }); return daemon; };

const sessionOf = (tenantId: string): TrustedSessionContext => ({
  tenantId, userId: "11111111-1111-1111-1111-111111111111",
  roles: [], groups: [], scope: "self", credential: "trusted-context",
});

/** The pilot is configured exactly as the deployment does: one socket, one tenant. */
const sandboxOf = (acceptsSession: (session: TrustedSessionContext) => boolean) =>
  createScriptedCapabilitySandbox(acceptsSession, {
    OPENSHAPEFORGE_SCRIPT_SANDBOX_SOCKET: socketPath,
    OPENSHAPEFORGE_SCRIPT_SANDBOX_PILOT_TENANTS: PILOT_TENANT,
  } as NodeJS.ProcessEnv)!;

/** Reports the denial code `host.read` threw, so the guest's own view is asserted. */
const READ_THEN_REPORT = `async function run(i) {
  const out = {};
  for (const alias of i.aliases) {
    try { out[alias] = await host.read(alias, { id: i.id }); }
    catch (error) { out[alias] = { denied: error.message }; }
  }
  return out;
}`;

describe("scripted capability bridge: authorized reads", () => {
  test("brokers only the aliases the caller listed, in the verified session", async () => {
    await start();
    const seen: { args: unknown; aborted: boolean }[] = [];
    const sandbox = sandboxOf(() => true);
    const bindings: RuntimeScriptedCapabilityBinding[] = [{
      alias: "exact.balance",
      read: (args, { signal }) => {
        seen.push({ args, aborted: signal.aborted });
        return { amount: (args as { id: number }).id * 10 };
      },
    }];
    // "toString" is a well-formed alias that exists on Object.prototype: it is
    // reachable only if the alias map inherits, which this bridge's map cannot.
    const result = await sandbox.evaluateReadOnly!(sessionOf(PILOT_TENANT), {
      source: READ_THEN_REPORT,
      input: { id: 4, aliases: ["exact.balance", "toString"] },
      bindings,
    });

    expect(result).toEqual({
      ok: true,
      value: { "exact.balance": { amount: 40 }, toString: { denied: "unknown_alias" } },
    });
    expect(seen).toEqual([{ args: { id: 4 }, aborted: false }]);
  });

  test("passes the run's cancellation to the callback and refuses a result it cannot bound", async () => {
    await start();
    const sandbox = sandboxOf(() => true);
    const cancellation = new AbortController();
    let cancelled: boolean | undefined;
    const result = await sandbox.evaluateReadOnly!(sessionOf(PILOT_TENANT), {
      source: READ_THEN_REPORT,
      input: { id: 1, aliases: ["cycle", "wait"] },
      bindings: [
        // A value no bounded JSON can carry is a sanitized refusal, not a crash.
        { alias: "cycle", read: () => { const value: Record<string, unknown> = {}; value.self = value; return value; } },
        {
          alias: "wait",
          read: (_args, { signal }) => new Promise(resolve => {
            signal.addEventListener("abort", () => { cancelled = true; resolve(null); }, { once: true });
            cancellation.abort();
          }),
        },
      ],
    }, { signal: cancellation.signal });

    expect(result).toEqual({ ok: false, code: "cancelled" });
    expect(cancelled).toBe(true);
  });
});

describe("scripted capability bridge: fixture evaluation stays read-free", () => {
  test("a fixture run reaches no binding, even one the same session may use", async () => {
    await start();
    const sandbox = sandboxOf(() => true);
    let calls = 0;
    const bindings: RuntimeScriptedCapabilityBinding[] = [
      { alias: "exact.balance", read: () => { calls += 1; return { amount: 7 }; } },
    ];
    const session = sessionOf(PILOT_TENANT);
    const request = { source: READ_THEN_REPORT, input: { id: 1, aliases: ["exact.balance"] } };

    expect(await sandbox.evaluateReadOnly!(session, { ...request, bindings }))
      .toEqual({ ok: true, value: { "exact.balance": { amount: 7 } } });
    expect(calls).toBe(1);

    // Same session, same source, same alias: the fixture API carries no bindings
    // and cannot be handed any, so the guest only learns the denial code.
    expect(await sandbox.evaluateFixture(session, request))
      .toEqual({ ok: true, value: { "exact.balance": { denied: "unknown_alias" } } });
    expect(calls).toBe(1);
  });

  test("fixture input is still bounded structured data", async () => {
    await start();
    const sandbox = sandboxOf(() => true);
    const result = await sandbox.evaluateFixture(sessionOf(PILOT_TENANT), {
      source: "function run(i) { return i.id + 1; }",
      input: [] as unknown as Readonly<Record<string, unknown>>,
    });
    expect(result).toEqual({ ok: false, code: "invalid_input" });
  });
});

describe("scripted capability bridge: refusals before the run", () => {
  // No daemon runs in these tests. A guard that refuses returns its own code;
  // anything that reached the transport first would report "worker_failed".
  test("another tenant's session reaches no binding and no run", async () => {
    let calls = 0;
    const sandbox = sandboxOf(() => true);
    const bindings: RuntimeScriptedCapabilityBinding[] = [
      { alias: "exact.balance", read: () => { calls += 1; return null; } },
    ];
    const request = { source: READ_THEN_REPORT, input: { id: 1, aliases: ["exact.balance"] }, bindings };

    expect(await sandbox.evaluateReadOnly!(sessionOf(OTHER_TENANT), request))
      .toEqual({ ok: false, code: "sandbox_unavailable" });
    expect(await sandbox.evaluateFixture(sessionOf(OTHER_TENANT), request))
      .toEqual({ ok: false, code: "sandbox_unavailable" });
    expect(calls).toBe(0);
    // The enabled tenant is refused only by the absent daemon, which is what
    // makes the codes above a guard rather than a transport failure.
    expect(await sandbox.evaluateReadOnly!(sessionOf(PILOT_TENANT), request))
      .toEqual({ ok: false, code: "worker_failed" });
  });

  test("a session the host no longer accepts reaches no binding and no run", async () => {
    let calls = 0;
    const sandbox = sandboxOf(() => false);
    const result = await sandbox.evaluateReadOnly!(sessionOf(PILOT_TENANT), {
      source: READ_THEN_REPORT,
      input: { id: 1, aliases: ["exact.balance"] },
      bindings: [{ alias: "exact.balance", read: () => { calls += 1; return null; } }],
    });
    expect(result).toEqual({ ok: false, code: "sandbox_unavailable" });
    expect(calls).toBe(0);
  });

  test("an alias list that is not explicit, well formed, unique and bounded is refused whole", async () => {
    const sandbox = sandboxOf(() => true);
    const read = () => null;
    const lists: readonly RuntimeScriptedCapabilityBinding[][] = [
      undefined as unknown as RuntimeScriptedCapabilityBinding[],
      [],
      [{ alias: "exact.balance", read }, { alias: "exact.balance", read }],
      [{ alias: "Exact.Balance", read }],
      [{ alias: "9balance", read }],
      [{ alias: `a${"b".repeat(64)}`, read }],
      [{ alias: "exact.balance", read: undefined as unknown as typeof read }],
      Array.from({ length: 33 }, (_, index) => ({ alias: `alias.n${index}`, read })),
    ];
    for (const bindings of lists) {
      expect(await sandbox.evaluateReadOnly!(sessionOf(PILOT_TENANT), {
        source: READ_THEN_REPORT, input: { id: 1, aliases: [] }, bindings,
      })).toEqual({ ok: false, code: "invalid_request" });
    }
  });
});

/**
 * A synthetic journal page in the shape the pilot's broker returns. Values are
 * invented locally: no credential, tenant name or external identifier appears.
 */
const journalPage = (rows: number) => ({
  since: "2026-11-01T00:00:00Z",
  next: "2026-11-02T00:00:00Z",
  rows: Array.from({ length: rows }, (_, index) => ({
    id: `GLT-${String(index).padStart(6, "0")}`,
    journal: index % 2 === 0 ? "70" : "90",
    entryNumber: 480_000 + index,
    date: "2026-11-01",
    glAccount: String(4000 + (index % 40)),
    glAccountDescription: "Operating expenses, cost centre Amsterdam",
    description: `Invoice line ${index} for period 11 of 2026`,
    costCentre: `CC-${100 + (index % 12)}`,
    amountDc: Number(((index % 997) + 0.37).toFixed(2)),
    currency: "EUR",
    vatCode: index % 3 === 0 ? "VH" : "VL",
    relation: `REL-${1000 + (index % 250)}`,
    modified: "2026-11-01T09:12:33.000Z",
  })),
});

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** The pilot's own script: one page in, the whole page projected back out. */
const PROJECT_WHOLE_PAGE = `async function run(i) {
  const page = await host.read("exact.journal", { since: i.since });
  const postings = [], lines = [];
  for (const row of page.rows) {
    postings.push({ ref: row.id, entry: row.entryNumber, account: row.glAccount, amount: row.amountDc, date: row.date });
    lines.push({ ref: row.id, description: row.description, vat: row.vatCode, relation: row.relation, centre: row.costCentre });
  }
  return { postings, lines, cursor: page.next, count: page.rows.length };
}`;

describe("scripted capability bridge: whole-page transfer", () => {
  test("carries a 1000-row page in and the whole data result back out", async () => {
    await start();
    const page = journalPage(1000);
    // The premise of this test: neither direction fits the single-frame budget.
    expect(jsonBytes(page)).toBeGreaterThan(128 * 1024);
    const seen: unknown[] = [];
    const sandbox = sandboxOf(() => true);

    const result = await sandbox.evaluateReadOnly!(sessionOf(PILOT_TENANT), {
      source: PROJECT_WHOLE_PAGE,
      input: { since: page.since },
      bindings: [{ alias: "exact.journal", read: args => { seen.push(args); return page; } }],
    });

    expect(seen).toEqual([{ since: page.since }]);
    if (!result.ok) throw new Error(`the run was refused: ${result.code}`);
    const value = result.value as { postings: unknown[]; lines: unknown[]; cursor: string; count: number };
    expect(jsonBytes(value)).toBeGreaterThan(128 * 1024);
    // Every record arrives, in order, unaltered: a transfer must not trim a page.
    expect(value.count).toBe(1000);
    expect(value.postings).toHaveLength(1000);
    expect(value.lines).toHaveLength(1000);
    expect(value.postings[0]).toEqual({
      ref: page.rows[0]!.id, entry: page.rows[0]!.entryNumber, account: page.rows[0]!.glAccount,
      amount: page.rows[0]!.amountDc, date: page.rows[0]!.date,
    });
    expect(value.lines[999]).toEqual({
      ref: page.rows[999]!.id, description: page.rows[999]!.description, vat: page.rows[999]!.vatCode,
      relation: page.rows[999]!.relation, centre: page.rows[999]!.costCentre,
    });
    // The cursor the caller may persist comes from the page that fully arrived.
    expect(value.cursor).toBe(page.next);
  }, 60_000);

  test("refuses a page over the transfer budget whole, with no records and no cursor", async () => {
    await start();
    // Beyond the brokered page budget: the only safe answer is the denial code.
    const page = journalPage(8_000);
    expect(jsonBytes(page)).toBeGreaterThan(1024 * 1024);
    let calls = 0;
    const sandbox = sandboxOf(() => true);

    const result = await sandbox.evaluateReadOnly!(sessionOf(PILOT_TENANT), {
      source: `async function run(i) {
        try {
          const page = await host.read("exact.journal", { since: i.since });
          return { rows: page.rows.length, cursor: page.next };
        } catch (error) { return { denied: error.message, rows: 0, cursor: null }; }
      }`,
      input: { since: page.since },
      bindings: [{ alias: "exact.journal", read: () => { calls += 1; return page; } }],
    });

    // The read was reached, so this is a refusal of the data, not of the alias.
    expect(calls).toBe(1);
    // No partial page and no next cursor: a caller cannot advance past records
    // it never received.
    expect(result).toEqual({ ok: true, value: { denied: "read_failed", rows: 0, cursor: null } });
  }, 60_000);

  test("keeps concurrent page transfers separate", async () => {
    await start();
    const pages = [journalPage(400), journalPage(600), journalPage(800)];
    const sandbox = sandboxOf(() => true);

    const results = await Promise.all(pages.map(page => sandbox.evaluateReadOnly!(sessionOf(PILOT_TENANT), {
      source: PROJECT_WHOLE_PAGE,
      input: { since: page.since },
      bindings: [{ alias: "exact.journal", read: () => page }],
    })));

    const values = results.map(result => {
      if (!result.ok) throw new Error(`the run was refused: ${result.code}`);
      return result.value as { postings: { ref: string }[]; count: number };
    });

    // Each run reassembles its own page: no chunk of one reaches another.
    expect(values.map(value => value.count)).toEqual([400, 600, 800]);
    for (const [index, value] of values.entries()) {
      expect(value.postings).toHaveLength(pages[index]!.rows.length);
      expect(value.postings[0]!.ref).toBe(pages[index]!.rows[0]!.id);
      expect(value.postings.at(-1)!.ref).toBe(pages[index]!.rows.at(-1)!.id);
    }
  }, 90_000);
});

describe("scripted capability bridge: session detached mid-run", () => {
  test("a session that detaches during the run reaches no further binding", async () => {
    await start();
    let live = true;
    const calls: string[] = [];
    const sandbox = sandboxOf(() => live);
    // The first read detaches the session, as a finished Operation would.
    const result = await sandbox.evaluateReadOnly!(sessionOf(PILOT_TENANT), {
      source: READ_THEN_REPORT,
      input: { id: 1, aliases: ["first.read", "second.read"] },
      bindings: [
        { alias: "first.read", read: () => { calls.push("first.read"); live = false; return { ok: true }; } },
        { alias: "second.read", read: () => { calls.push("second.read"); return { ok: true }; } },
      ],
    });

    expect(result).toEqual({
      ok: true,
      value: { "first.read": { ok: true }, "second.read": { denied: "read_failed" } },
    });
    expect(calls).toEqual(["first.read"]);
  });
});
