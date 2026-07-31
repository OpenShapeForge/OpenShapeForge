// SPDX-License-Identifier: BUSL-1.1
/**
 * The workflow definition ACL and the editor lock, driven through GraphQL.
 *
 * `definition-authorization.unit.test.ts` already pins the decision function.
 * What that cannot show is whether the decision survives the two layers between
 * it and a caller: the resolvers the plugin contributes, and the database
 * session that supplies the subjects the ACL is compared against. Those layers
 * are where a correct predicate stops mattering — a resolver that forgets to
 * call it, or a session that hands it a different set of groups than the caller
 * presented, is indistinguishable at the API from a broken rule.
 *
 * ## The group case is the one that has to hold
 *
 * In the model this ports from, `groups` was parsed and never evaluated, so a
 * definition whose `view` named only groups was neither empty — therefore not
 * public — nor matching. It went invisible to everyone including its author,
 * permanently and with no way back through the API.
 *
 * Proving that end to end needs a group id the session layer will actually
 * carry. `normalizeGroups` in `apps/api/src/db/session.ts` keeps only UUIDs, so
 * a `groups` subject in a stored ACL has to name an org unit; a readable label
 * like "team-a" satisfies the unit test and reaches the ACL check as nothing at
 * all. The group ids below are therefore UUIDs, and the non-member is a second
 * session that differs from the author ONLY in its group — same tenant, same
 * writer role — so a passing test cannot be explained by the role instead.
 *
 * ## An ACL narrows the writer role and never widens it
 *
 * The other half is `edit` naming a session that holds no writer role. It is
 * still refused, because otherwise one editable definition would be enough to
 * grant its holder every other one.
 *
 * Runs against a throwaway database built by the full migration chain including
 * the workflow module's own seeds — the module hydrates its node catalog from
 * those rows at init, and a module that fails to initialise is dropped along
 * with its entire GraphQL surface.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/graphql/__tests__/workflow-authorization.e2e.test.ts 2>&1
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { graphql, type ExecutionResult, type GraphQLSchema } from "graphql";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { initRuntimeModules, loadRuntimeModules } from "../../modules/registry.js";
import { buildGraphqlSchema } from "../schema.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 90_000;

/** The realm role `WORKFLOW_WRITER_ROLES` admits; authoring requires it. */
const WRITER_ROLE = "directie";
/** A realm role that is not one of those: enough to read, never to author. */
const NON_WRITER_ROLE = "controller";

/**
 * `WORKFLOW_DEFINITION_LOCK_TTL_MS`, restated rather than imported: this
 * workspace's tsconfig has `rootDir: src`, so nothing under `examples/` is
 * reachable from a file that has to typecheck as part of apps/api.
 */
const LOCK_TTL_MS = 15 * 60_000;

/** The one shape the storage layer promises its readers, and nothing more. */
const EMPTY_GRAPH = { nodes: [], edges: [] };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Scratch database, migrated and module-initialised once for the whole file
// ---------------------------------------------------------------------------

type Harness = { runtime: DatabaseRuntime; schema: GraphQLSchema };

let admin: SQL | null = null;
let scratchDatabase: string | null = null;
let runtime: DatabaseRuntime | null = null;
let booted: Promise<Harness> | null = null;

async function boot(): Promise<Harness> {
  const name = `wfauthz_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe scratch database name: ${name}`);
  }

  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }

  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  scratchDatabase = name;
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();

  const modules = await loadRuntimeModules();
  expect(modules.failures).toEqual([]);

  const migrate = createDatabaseRuntime({ databaseUrl, maxConnections: 1 });
  try {
    // Steps 3 and 4 of the chain drive explicit BEGIN/COMMIT, so they need a
    // single bound connection rather than the pool.
    await migrate.db
      .connection()
      .execute((conn) =>
        runMigrationChain(conn, {
          moduleSeeds: modules.loaded.flatMap((module) => module.seeds ?? []),
        }),
      );
  } finally {
    await migrate.close();
  }

  const created = createDatabaseRuntime({ databaseUrl, maxConnections: 4 });
  runtime = created;

  // A module whose `init` throws is recorded as a failure and dropped, which
  // would leave every field below undefined in the schema rather than failing
  // here. Assert the load instead of discovering it as a null resolver.
  const initialised = await initRuntimeModules(modules, { db: created.db });
  expect(initialised.failures).toEqual([]);
  expect(initialised.loaded.map((module) => module.name)).toContain("workflow");

  return { runtime: created, schema: buildGraphqlSchema(initialised.loaded, { db: created.db }) };
}

function harness(): Promise<Harness> {
  return (booted ??= boot());
}

afterAll(async () => {
  await runtime?.close();
  if (admin) {
    if (scratchDatabase) {
      await admin.unsafe(`drop database if exists "${scratchDatabase}" with (force)`);
    }
    await admin.close();
  }
});

// ---------------------------------------------------------------------------
// Sessions and transport
// ---------------------------------------------------------------------------

type Session = {
  tenantId: string;
  userId: string;
  roles: string[];
  groups: string[];
  scope: "tenant";
};

/**
 * Three sessions in a tenant of their own, so a list read can be asserted
 * exactly instead of searched.
 *
 * `otherWriter` differs from `author` only in its group; `reader` differs only
 * in its role. Every denial below can therefore be attributed to one subject
 * kind rather than to the combination.
 */
function tenantSessions() {
  const tenantId = randomUUID();
  const groupA = randomUUID();
  const groupB = randomUUID();
  const sessionFor = (roles: string[], groups: string[]): Session => ({
    tenantId,
    userId: randomUUID(),
    roles,
    groups,
    scope: "tenant",
  });

  return {
    groupA,
    author: sessionFor([WRITER_ROLE], [groupA]),
    otherWriter: sessionFor([WRITER_ROLE], [groupB]),
    reader: sessionFor([NON_WRITER_ROLE], [groupB]),
  };
}

async function execute(
  session: Session,
  source: string,
  variableValues: Record<string, unknown> = {},
): Promise<ExecutionResult> {
  const { runtime: db, schema } = await harness();
  return graphql({ schema, source, contextValue: { db: db.db, session }, variableValues });
}

async function expectData(
  session: Session,
  source: string,
  variableValues: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const result = await execute(session, source, variableValues);
  expect(result.errors ?? []).toEqual([]);
  expect(result.data).toBeTruthy();
  return result.data as Record<string, any>;
}

async function errorCode(
  session: Session,
  source: string,
  variableValues: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await execute(session, source, variableValues);
  return result.errors?.[0]?.extensions?.code;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const CREATE = /* GraphQL */ `
  mutation CreateDefinition($input: CreateWorkflowDefinitionInput!) {
    createWorkflowDefinition(input: $input) {
      id
      name
      updatedAt
    }
  }
`;

const UPDATE = /* GraphQL */ `
  mutation UpdateDefinition($input: UpdateWorkflowDefinitionInput!) {
    updateWorkflowDefinition(input: $input) {
      id
      name
    }
  }
`;

const SAVE = /* GraphQL */ `
  mutation SaveVersion($input: SaveWorkflowDefinitionVersionInput!) {
    saveWorkflowDefinitionVersion(input: $input) {
      id
      latestVersion
      updatedAt
    }
  }
`;

const PUBLISH = /* GraphQL */ `
  mutation PublishVersion($input: PublishWorkflowDefinitionVersionInput!) {
    publishWorkflowDefinitionVersion(input: $input) {
      id
      version
    }
  }
`;

const ARCHIVE = /* GraphQL */ `
  mutation ArchiveDefinition($definitionId: ID!) {
    archiveWorkflowDefinition(definitionId: $definitionId) {
      id
      isActive
    }
  }
`;

const DELETE = /* GraphQL */ `
  mutation DeleteDefinition($definitionId: ID!) {
    deleteWorkflowDefinitionPermanently(definitionId: $definitionId)
  }
`;

const READ_ONE = /* GraphQL */ `
  query Definition($id: ID!) {
    workflowDefinition(id: $id) {
      id
      name
      isActive
    }
  }
`;

const READ_ALL = /* GraphQL */ `
  query Definitions {
    workflowDefinitions {
      id
      name
    }
  }
`;

const ACQUIRE_LOCK = /* GraphQL */ `
  mutation AcquireLock($definitionId: ID!) {
    acquireWorkflowDefinitionLock(definitionId: $definitionId) {
      definitionId
      lockToken
      ownerUserId
      acquiredAt
      expiresAt
    }
  }
`;

const RELEASE_LOCK = /* GraphQL */ `
  mutation ReleaseLock($definitionId: ID!, $lockToken: String!) {
    releaseWorkflowDefinitionLock(definitionId: $definitionId, lockToken: $lockToken)
  }
`;

const STEAL_LOCK = /* GraphQL */ `
  mutation StealLock($definitionId: ID!) {
    stealWorkflowDefinitionLock(definitionId: $definitionId) {
      lockToken
      ownerUserId
      expiresAt
    }
  }
`;

const READ_LOCK = /* GraphQL */ `
  query Lock($definitionId: ID!) {
    workflowDefinitionLock(definitionId: $definitionId) {
      lockToken
      ownerUserId
      expiresAt
    }
  }
`;

type DefinitionHandle = { id: string; name: string; updatedAt: string };

async function createDefinition(
  session: Session,
  authorization?: Record<string, unknown>,
): Promise<DefinitionHandle> {
  const input: Record<string, unknown> = { name: `definition-${randomUUID().slice(0, 8)}` };
  if (authorization) input["authorization"] = authorization;
  const data = await expectData(session, CREATE, { input });
  return data["createWorkflowDefinition"] as DefinitionHandle;
}

async function acquireLock(session: Session, definitionId: string) {
  const data = await expectData(session, ACQUIRE_LOCK, { definitionId });
  return data["acquireWorkflowDefinitionLock"] as {
    lockToken: string;
    ownerUserId: string;
    acquiredAt: string;
    expiresAt: string;
  };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Every write the surface exposes, so the role gate is asserted once per
 * operation rather than once per operation the author of this file remembered.
 */
const WRITES: {
  name: string;
  document: string;
  variables: (definition: DefinitionHandle) => Record<string, unknown>;
}[] = [
  {
    name: "create",
    document: CREATE,
    variables: () => ({ input: { name: "refused-before-it-exists" } }),
  },
  {
    name: "update",
    document: UPDATE,
    variables: (definition) => ({ input: { definitionId: definition.id, name: "renamed" } }),
  },
  {
    name: "save",
    document: SAVE,
    variables: (definition) => ({
      input: {
        definitionId: definition.id,
        expectedUpdatedAt: definition.updatedAt,
        definition: EMPTY_GRAPH,
      },
    }),
  },
  {
    name: "publish",
    document: PUBLISH,
    variables: (definition) => ({ input: { definitionId: definition.id, version: 1 } }),
  },
  {
    name: "archive",
    document: ARCHIVE,
    variables: (definition) => ({ definitionId: definition.id }),
  },
  {
    name: "delete",
    document: DELETE,
    variables: (definition) => ({ definitionId: definition.id }),
  },
];

describe("workflow definition authorization through GraphQL", () => {
  test(
    "a session without a writer role is refused every write",
    async () => {
      const { author, reader } = tenantSessions();
      const definition = await createDefinition(author);

      const outcomes: Record<string, unknown> = {};
      for (const write of WRITES) {
        outcomes[write.name] = await errorCode(reader, write.document, write.variables(definition));
      }
      expect(outcomes).toEqual({
        create: "FORBIDDEN",
        update: "FORBIDDEN",
        save: "FORBIDDEN",
        publish: "FORBIDDEN",
        archive: "FORBIDDEN",
        delete: "FORBIDDEN",
      });

      // The refusals have to have refused: an archive or delete that reported
      // FORBIDDEN and still ran would satisfy every assertion above.
      const survivor = await expectData(author, READ_ONE, { id: definition.id });
      expect(survivor["workflowDefinition"]).toEqual({
        id: definition.id,
        name: definition.name,
        isActive: true,
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a session without a writer role can still read",
    async () => {
      const { author, reader } = tenantSessions();
      const definition = await createDefinition(author);

      const single = await expectData(reader, READ_ONE, { id: definition.id });
      expect(single["workflowDefinition"]?.id).toBe(definition.id);

      const listed = await expectData(reader, READ_ALL);
      expect(listed["workflowDefinitions"]).toEqual([
        { id: definition.id, name: definition.name },
      ]);
    },
    TEST_TIMEOUT,
  );

  test(
    "an ACL that names nobody is visible to everyone in the tenant",
    async () => {
      const { author, otherWriter, reader } = tenantSessions();
      // No `authorization` at all, which is what a freshly created definition
      // carries: restriction is opt-in.
      const definition = await createDefinition(author);

      for (const session of [author, otherWriter, reader]) {
        const data = await expectData(session, READ_ONE, { id: definition.id });
        expect(data["workflowDefinition"]?.id).toBe(definition.id);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "a definition restricted to a group is visible to a member and absent for a non-member",
    async () => {
      const { author, otherWriter, groupA } = tenantSessions();
      const definition = await createDefinition(author, { view: { groups: [groupA] } });

      // The regression: with `groups` parsed but not evaluated this ACL is
      // neither empty nor matching, so it hid the definition from its author
      // too — and only the author could have repaired it.
      const asAuthor = await expectData(author, READ_ONE, { id: definition.id });
      expect(asAuthor["workflowDefinition"]?.id).toBe(definition.id);
      const authorList = await expectData(author, READ_ALL);
      expect(authorList["workflowDefinitions"].map((row: { id: string }) => row.id)).toEqual([
        definition.id,
      ]);

      // Same tenant, same writer role, different group. An invisible definition
      // reads as absent rather than as a refusal: saying it exists but is not
      // yours is itself a disclosure.
      const asNonMember = await expectData(otherWriter, READ_ONE, { id: definition.id });
      expect(asNonMember["workflowDefinition"]).toBeNull();
      const nonMemberList = await expectData(otherWriter, READ_ALL);
      expect(nonMemberList["workflowDefinitions"]).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a definition restricted to a named user is visible only to that user",
    async () => {
      const { author, reader } = tenantSessions();
      const definition = await createDefinition(author, { view: { users: [author.userId] } });

      const asNamed = await expectData(author, READ_ONE, { id: definition.id });
      expect(asNamed["workflowDefinition"]?.id).toBe(definition.id);

      const asOther = await expectData(reader, READ_ONE, { id: definition.id });
      expect(asOther["workflowDefinition"]).toBeNull();
      const otherList = await expectData(reader, READ_ALL);
      expect(otherList["workflowDefinitions"]).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  test(
    "an ACL naming a user in `edit` does not grant that user the writer role",
    async () => {
      const { author, reader } = tenantSessions();
      // The author is named alongside the reader because `create` refuses an
      // authorization its own author could not then edit; the point under test
      // is the reader's entry, not the author's.
      const definition = await createDefinition(author, {
        edit: { users: [reader.userId, author.userId] },
      });

      // The reader can see it — `view` names nobody — and is named in `edit`.
      const visible = await expectData(reader, READ_ONE, { id: definition.id });
      expect(visible["workflowDefinition"]?.id).toBe(definition.id);

      expect(
        await errorCode(reader, UPDATE, {
          input: { definitionId: definition.id, name: "escalated" },
        }),
      ).toBe("FORBIDDEN");
      expect(
        await errorCode(reader, SAVE, {
          input: {
            definitionId: definition.id,
            expectedUpdatedAt: definition.updatedAt,
            definition: EMPTY_GRAPH,
          },
        }),
      ).toBe("FORBIDDEN");
    },
    TEST_TIMEOUT,
  );

  test(
    "edit and delete are independent grants",
    async () => {
      const { author, otherWriter } = tenantSessions();
      const definition = await createDefinition(author, {
        edit: { users: [author.userId] },
        delete: { users: [otherWriter.userId] },
      });

      const saved = await expectData(author, SAVE, {
        input: {
          definitionId: definition.id,
          expectedUpdatedAt: definition.updatedAt,
          definition: EMPTY_GRAPH,
        },
      });
      expect(saved["saveWorkflowDefinitionVersion"].latestVersion).toBe(1);

      expect(await errorCode(author, ARCHIVE, { definitionId: definition.id })).toBe("FORBIDDEN");
      const stillActive = await expectData(author, READ_ONE, { id: definition.id });
      expect(stillActive["workflowDefinition"]?.isActive).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Editor locks
// ---------------------------------------------------------------------------

describe("workflow definition editor locks through GraphQL", () => {
  test(
    "acquiring returns a token and a lease about fifteen minutes out",
    async () => {
      const { author } = tenantSessions();
      const definition = await createDefinition(author);

      const lock = await acquireLock(author, definition.id);
      expect(lock.ownerUserId).toBe(author.userId);
      expect(lock.lockToken).toMatch(UUID_PATTERN);
      // Both instants come from the database's clock, so the lease is asserted
      // as a window rather than against this process's `Date.now()`.
      const lease = Date.parse(lock.expiresAt) - Date.parse(lock.acquiredAt);
      expect(lease).toBeGreaterThan(LOCK_TTL_MS - 1_000);
      expect(lease).toBeLessThanOrEqual(LOCK_TTL_MS + 1_000);

      const read = await expectData(author, READ_LOCK, { definitionId: definition.id });
      expect(read["workflowDefinitionLock"]?.lockToken).toBe(lock.lockToken);
    },
    TEST_TIMEOUT,
  );

  test(
    "a second user cannot acquire a live lock",
    async () => {
      const { author, otherWriter } = tenantSessions();
      const definition = await createDefinition(author);
      await acquireLock(author, definition.id);

      expect(await errorCode(otherWriter, ACQUIRE_LOCK, { definitionId: definition.id })).toBe(
        "LOCK_HELD",
      );
    },
    TEST_TIMEOUT,
  );

  test(
    "the holder re-acquiring their own lock refreshes it",
    async () => {
      const { author } = tenantSessions();
      const definition = await createDefinition(author);

      const first = await acquireLock(author, definition.id);
      const refreshed = await acquireLock(author, definition.id);
      expect(refreshed.ownerUserId).toBe(author.userId);
      // The token identifies a holding session rather than a person, so a
      // refresh rotates it and the caller has to keep the new one.
      expect(refreshed.lockToken).not.toBe(first.lockToken);
      expect(Date.parse(refreshed.expiresAt)).toBeGreaterThanOrEqual(Date.parse(first.expiresAt));
    },
    TEST_TIMEOUT,
  );

  test(
    "releasing takes the right token, and a wrong one is answered rather than raised",
    async () => {
      const { author } = tenantSessions();
      const definition = await createDefinition(author);
      const lock = await acquireLock(author, definition.id);

      // A stale token usually means a tab closing after the lease lapsed —
      // a fact about the world, not a fault in the request.
      const wrong = await expectData(author, RELEASE_LOCK, {
        definitionId: definition.id,
        lockToken: randomUUID(),
      });
      expect(wrong["releaseWorkflowDefinitionLock"]).toBe(false);

      const right = await expectData(author, RELEASE_LOCK, {
        definitionId: definition.id,
        lockToken: lock.lockToken,
      });
      expect(right["releaseWorkflowDefinitionLock"]).toBe(true);

      const afterwards = await expectData(author, READ_LOCK, { definitionId: definition.id });
      expect(afterwards["workflowDefinitionLock"]).toBeNull();
    },
    TEST_TIMEOUT,
  );

  test(
    "stealing takes a live lock and retires the previous token",
    async () => {
      const { author, otherWriter } = tenantSessions();
      const definition = await createDefinition(author);
      const held = await acquireLock(author, definition.id);

      const stolen = await expectData(otherWriter, STEAL_LOCK, { definitionId: definition.id });
      const thief = stolen["stealWorkflowDefinitionLock"];
      expect(thief.ownerUserId).toBe(otherWriter.userId);
      expect(thief.lockToken).not.toBe(held.lockToken);

      const stale = await expectData(author, RELEASE_LOCK, {
        definitionId: definition.id,
        lockToken: held.lockToken,
      });
      expect(stale["releaseWorkflowDefinitionLock"]).toBe(false);

      const current = await expectData(author, READ_LOCK, { definitionId: definition.id });
      expect(current["workflowDefinitionLock"]?.ownerUserId).toBe(otherWriter.userId);
    },
    TEST_TIMEOUT,
  );

  test(
    "an unlocked definition reports no lock",
    async () => {
      const { author } = tenantSessions();
      const definition = await createDefinition(author);

      const read = await expectData(author, READ_LOCK, { definitionId: definition.id });
      expect(read["workflowDefinitionLock"]).toBeNull();
    },
    TEST_TIMEOUT,
  );
});
