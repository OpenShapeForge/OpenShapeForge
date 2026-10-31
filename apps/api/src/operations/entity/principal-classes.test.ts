// SPDX-License-Identifier: BUSL-1.1
/**
 * The principal-class policy on generated CRUD and the search derived from it.
 *
 * The hole this closes: an entity can hand an application a named action on
 * one record, and that application's key may hold the entity's ordinary read
 * role on its service account. Generated CRUD, generated search and the MCP
 * tools ask only for the role, so the collection would hand it every record of
 * the entity and make the per-record grant decorative.
 *
 * `Notebook` is the subject: it declares `deliver` for integrations, so the
 * compiler derived `principalClasses: [person, service, unknown]` for it. The
 * tests pin that the derivation holds, that every generic route refuses an
 * application WHILE IT HOLDS THE ROLE, that the authored action-gated
 * Operation is untouched, and that an entity which declares no action is
 * unaffected.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { operationErrorOf } from "@openshapeforge/operations";
import type { DbSessionInput } from "../../db/session.js";
import { getGeneratedCrudTables, readGeneratedCrudTable } from "./catalog.js";
import {
  admittedPrincipalClasses,
  assertEntityAdmitsPrincipal,
  entityAdmitsPrincipal,
} from "./principal-classes.js";
import { getEntityOperationOffers } from "./runtime.js";
import { sessionMayInvoke } from "../../mcp/session-projection.js";
import { catalog } from "../../mcp/catalog.js";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { nativeApplicationSearchHandler } from "../application-search.js";
import { ModulePlatformRuntime, withModuleOperationSession } from "../../modules/platform.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";

const tenantId = randomUUID();
const integrationId = randomUUID();
const credentialId = randomUUID();

const NOTEBOOK_TABLE = "notebook.notebooks";
const NOTEBOOK_ROLES = [
  "General.All.Read",
  "General.All.ReadWrite",
  "Organization.All.ReadWrite",
];
const INTENTS = ["list", "get", "create", "update", "delete"] as const;

function table(name: string) {
  return getGeneratedCrudTables().find((candidate) => candidate.name === name)!;
}

/** Every session below holds every notebook role: the class is the variable. */
function session(overrides: Partial<DbSessionInput> = {}): DbSessionInput {
  return {
    tenantId,
    userId: randomUUID(),
    roles: NOTEBOOK_ROLES,
    groups: [],
    relationGroupIds: [],
    scope: "tenant",
    ...overrides,
  };
}

const application = () => session({ principalKind: "service", appPrincipal: { integrationId, credentialId } });
const serviceAccount = () => session({ principalKind: "service" });
const person = () => session({ principalKind: "person" });
const unclassified = () => session();

/**
 * The carrier that states no kind but DOES carry a verified identity link to
 * a person Relation: a payload-v2 trusted-context bundle, which this
 * deployment still accepts for ordinary work.
 *
 * It is `unknown`, because a party type is not evidence of a human login
 * (db/session.ts, `resolvePrincipalClass`). That is a real compatibility
 * consequence, so it is pinned on both sides here: the compiler's derived
 * default admits `unknown`, so this session keeps reaching every generic
 * route it reached before — and an entity that authors `[person]` does not
 * admit it, which is the surface its producer reaches by signing v3.
 */
const linkedToPersonParty = () => session({
  relation: {
    identityId: randomUUID(),
    issuer: "https://identity.example/realms/test",
    subject: randomUUID(),
    status: "linked",
    relationId: randomUUID(),
    relationType: "person",
  },
} as Partial<DbSessionInput>);

function refusalCode(call: () => unknown): string | undefined {
  try {
    call();
  } catch (error) {
    return operationErrorOf(error)?.code;
  }
  return undefined;
}

describe("the compiled policy", () => {
  test("an entity that declares an action for integrations excludes applications", () => {
    expect(admittedPrincipalClasses(table(NOTEBOOK_TABLE)))
      .toEqual(["person", "service", "unknown"]);
  });

  test("an entity that declares no action and authors no list admits every class", () => {
    const relation = table("erp.relations");
    expect(relation.source?.authorization?.recordPermissions?.actions).toBeUndefined();
    expect(admittedPrincipalClasses(relation)).toBeUndefined();
    for (const candidate of [application(), serviceAccount(), person(), unclassified()]) {
      expect(entityAdmitsPrincipal(relation, candidate)).toBe(true);
    }
  });

  test("exactly one class is excluded, and it is the derived one", () => {
    const notebook = table(NOTEBOOK_TABLE);
    expect(entityAdmitsPrincipal(notebook, application())).toBe(false);
    // Organization automation and every other configured service account keep
    // working: they hold no record action either, and nothing about their
    // existing access changes.
    expect(entityAdmitsPrincipal(notebook, serviceAccount())).toBe(true);
    expect(entityAdmitsPrincipal(notebook, person())).toBe(true);
    expect(entityAdmitsPrincipal(notebook, unclassified())).toBe(true);
    // And so does a linked v2 bundle, which is `unknown` and not a person.
    expect(entityAdmitsPrincipal(notebook, linkedToPersonParty())).toBe(true);
  });

  test("an entity that authors [person] admits a verified person and nothing like one", () => {
    // The derived default never excludes `unknown`, so the only way to author
    // a policy a linked v2 bundle fails is to write `person` out — which is
    // the entity deciding that this route needs a human, and is the decision
    // the class exists to carry.
    const personsOnly = {
      ...table(NOTEBOOK_TABLE),
      source: {
        ...table(NOTEBOOK_TABLE).source,
        authorization: {
          ...table(NOTEBOOK_TABLE).source?.authorization,
          principalClasses: ["person"],
        },
      },
    } as ReturnType<typeof table>;
    expect(admittedPrincipalClasses(personsOnly)).toEqual(["person"]);
    expect(entityAdmitsPrincipal(personsOnly, person())).toBe(true);
    for (const candidate of [
      linkedToPersonParty(), unclassified(), serviceAccount(), application(),
    ]) {
      expect(entityAdmitsPrincipal(personsOnly, candidate)).toBe(false);
    }
    // The refusal names the class it refused, so an integrator reading it is
    // not left looking for a missing role.
    expect(refusalCode(() => assertEntityAdmitsPrincipal(personsOnly, linkedToPersonParty())))
      .toBe("FORBIDDEN");
  });
});

describe("the generic routes refuse an application that holds the role", () => {
  test("REST and GraphQL: the shared CRUD resolver every route goes through", () => {
    // readGeneratedCrudTable is the only by-name table resolver, and both
    // transports reach generated CRUD through it (operations/entity/queries.ts
    // and mutations.ts), so one refusal here is both transports.
    for (const intent of INTENTS) {
      expect(refusalCode(() => readGeneratedCrudTable(NOTEBOOK_TABLE, intent, application())))
        .toBe("FORBIDDEN");
      // The same call, same roles, a service account rather than an
      // application: admitted. The class is what refuses, not the role.
      expect(readGeneratedCrudTable(NOTEBOOK_TABLE, intent, serviceAccount()).name)
        .toBe(NOTEBOOK_TABLE);
      expect(readGeneratedCrudTable(NOTEBOOK_TABLE, intent, person()).name)
        .toBe(NOTEBOOK_TABLE);
    }
  });

  test("the refusal names the principal class and not the entity's policy", () => {
    let message: string | undefined;
    try {
      readGeneratedCrudTable(NOTEBOOK_TABLE, "list", application());
    } catch (error) {
      message = operationErrorOf(error)?.message;
    }
    expect(message).toContain("Notebook");
    expect(message).toContain("application");
    // No role enumeration and no disclosure of which classes are admitted.
    for (const leak of [...NOTEBOOK_ROLES, "person", "service", "unknown"]) {
      expect(message).not.toContain(leak);
    }
  });

  test("MCP: the generated tools are withheld from the listing too", () => {
    const notebook = table(NOTEBOOK_TABLE);
    for (const intent of INTENTS) {
      expect([intent, sessionMayInvoke(notebook as never, intent, application())])
        .toEqual([intent, false]);
      expect([intent, sessionMayInvoke(notebook as never, intent, serviceAccount())])
        .toEqual([intent, true]);
    }
    // The tools exist — this is a policy refusal, not a missing projection.
    expect(catalog.entities.some((entity) => entity.table === NOTEBOOK_TABLE)).toBe(true);
  });

  test("entity offers drop the generated operations and keep the authored action", () => {
    const grantedRow = {
      id: randomUUID(),
      permissions: { actions: { deliver: { integrations: [integrationId] } } },
    };
    const target = { id: String(grantedRow.id), row: grantedRow };
    const offered = (input: DbSessionInput) =>
      getEntityOperationOffers("Notebook", input, [...INTENTS], {}, target)
        .map((offer) => offer.operation.id);

    const forApplication = offered(application());
    // Not one generated operation…
    expect(forApplication.filter((id) => id.startsWith("Notebook.") &&
      INTENTS.some((intent) => id === `Notebook.${intent}`))).toEqual([]);
    // …and the action-gated Operation it was actually granted is still there.
    // The policy governs the generic routes; it is not a ban on the entity.
    expect(forApplication).toContain("Notebook.deliver");

    const forPerson = offered(person());
    expect(forPerson).toContain("Notebook.get");
    expect(forPerson).toContain("Notebook.update");
    // And the person holds no `deliver`: that action admits integrations only.
    expect(forPerson).not.toContain("Notebook.deliver");
  });
});

/**
 * The derived search reads nothing it was not offered: it enumerates the
 * session's Operations and only reads the entities whose `list` is among
 * them. So the control is the Operation listing, and that is what this pins
 * — once for the listing, once for the handler's use of it.
 */
describe("the search derived from generated CRUD", () => {
  function runtime() {
    const db = new Kysely<never>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (candidate) => new PostgresIntrospector(candidate),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    return { host: new ModulePlatformRuntime(db as never), db };
  }

  async function listed(input: DbSessionInput): Promise<string[]> {
    const { host, db } = runtime();
    try {
      return await withModuleOperationSession(
        host.services,
        input as TrustedSessionContext,
        async (live) =>
          (await host.listOperationSnapshot(live!)).definitions.map((definition) => definition.id),
      );
    } finally {
      await db.destroy();
    }
  }

  test("an application is not offered the excluded entity's Operations", async () => {
    const forApplication = await listed(application());
    expect(forApplication).not.toContain("Notebook.list");
    expect(forApplication).not.toContain("Notebook.get");
    // Its roles are intact everywhere else, which is what makes this a
    // per-entity policy and not a credential-wide one.
    expect(forApplication).toContain("Document.list");
    // Its snapshot entity carries the same policy, authored rather than
    // derived: a version would otherwise return the body the head withholds.
    expect(forApplication).not.toContain("NotebookVersion.list");

    const forService = await listed(serviceAccount());
    expect(forService).toContain("Notebook.list");
    expect(forService).toContain("Notebook.get");
  });

  test("a source whose list Operation is not offered is not read and not listed", async () => {
    // The handler, with the listing an application would get: Notebook is
    // absent from the offered Operations, so it is absent from the catalogue
    // and `execute` is never called for it.
    const operation = {
      key: "application.search",
      plugin: "core",
      auth: { mode: "session" },
      tenancy: { mode: "required" },
      effects: { data: "read", external: "none" },
      implementation: {
        type: "application-search",
        sources: [
          { entity: "Notebook", labels: { en: "Notebooks" }, list: "Notebook.list", get: "Notebook.get", field: "name" },
          { entity: "Document", labels: { en: "Documents" }, list: "Document.list", get: "Document.get", field: "name" },
        ],
      },
    };
    const offered = await listed(application());
    const result = await nativeApplicationSearchHandler(operation as never)(
      { locale: "en" },
      {
        session: { tenantId, userId: randomUUID() },
        platform: {
          operations: {
            list: async () => offered.map((id) => ({ id })),
            get: async (_session: unknown, id: string) => offered.includes(id) ? { id } : undefined,
            execute: () => {
              throw new Error("An empty query must read no records.");
            },
          },
        },
      } as never,
    );
    const value = ("value" in result ? result.value : null) as { entities: Array<{ entity: string }> };
    expect(value.entities.map((entry) => entry.entity)).toEqual(["Document"]);
  });
});
