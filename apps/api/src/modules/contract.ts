// SPDX-License-Identifier: BUSL-1.1
/**
 * The runtime half of the plugin contract.
 *
 * `CompilerPlugin` (packages/compiler/src/plugins.ts) runs inside
 * `bun run generate`: it contributes platform tables and emits artifacts, and
 * every hook must be a pure function of the repo state. Runtime concerns cannot
 * live there. `connectors/loader.ts` states why, and it applies verbatim:
 *
 *   The compiler must never do this — output would depend on node_modules and
 *   the determinism gates would break — so resolution happens here, once, at
 *   boot.
 *
 * So a plugin package has two entry points. The compiler imports `<plugin>` for
 * its `CompilerPlugin`; the API imports `<plugin>/runtime` for a `RuntimeModule`
 * and gets GraphQL, routes, seeds and worker roles from it. Both are registered
 * by the same `plugins:` list in authoring.config.yaml, so a deployment cannot
 * end up running one half without the other.
 *
 * A plugin with no runtime entry point is normal, not an error — `entity-docs`
 * has nothing to contribute at runtime.
 *
 * GraphQL contributions are split into typeDefs / query fields / mutation
 * fields rather than one SDL blob because the root types are assembled, not
 * concatenated: `type Query { … }` appears exactly once and every module adds
 * fields inside it. Handing us a second `type Query` would be a schema error
 * that only surfaced at boot.
 */
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import type { CatalogSeedResult } from "../db/migrations/catalog-seed.js";

/** What a module may read when building its surfaces. */
export type ModuleRuntimeContext = {
  /** Absent when DATABASE_URL is unset; a module must degrade, not throw. */
  db?: OpenShapeForgeDatabase | undefined;
};

export type ModuleGraphqlContribution = {
  /** Type/input/enum definitions. Must NOT declare `type Query`/`type Mutation`. */
  typeDefs?: string;
  /** Field lines spliced into the single root `type Query`. */
  queryFields?: string;
  /** Field lines spliced into the single root `type Mutation`. */
  mutationFields?: string;
  /**
   * Resolvers keyed by type name, including `Query` and `Mutation`. Merged
   * per type, so two modules may each add root fields; colliding field names
   * are refused at boot rather than silently last-wins.
   */
  resolvers?: Record<string, Record<string, unknown>>;
};

/** A migration-chain seed step contributed by a module. */
export type ModuleSeed = {
  /** Reported under this key in the db:migrate output. */
  name: string;
  apply(db: Kysely<DB>): Promise<CatalogSeedResult>;
};

/**
 * The logger a worker writes to. Structurally the slice of Fastify's logger a
 * worker needs, declared here so a plugin's worker does not have to import
 * Fastify — or, worse, reach for `console` and land outside the process's log
 * stream.
 */
export type ModuleWorkerLogger = {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
};

/**
 * What a worker may read when it starts.
 *
 * `db` is REQUIRED here, unlike {@link ModuleRuntimeContext} where a module must
 * degrade without one. A GraphQL surface with no database can still answer with
 * DATABASE_NOT_CONFIGURED; a queue-draining worker with no database has nothing
 * to do at all, so the worker role refuses to start rather than idling.
 */
export type ModuleWorkerContext = {
  db: OpenShapeForgeDatabase;
  log: ModuleWorkerLogger;
};

export type ModuleWorkerHandle = {
  /**
   * Stop, and settle only AFTER the in-flight tick has finished.
   *
   * A `stop()` that returns while a command is still claimed leaves the row
   * `processing` until the visibility timeout reclaims it — a shutdown that
   * costs the next worker a delay and an attempt, every time, which is exactly
   * the sort of thing nobody notices until the retry bound is reached.
   */
  stop(): Promise<void>;
};

/**
 * A long-running process a module contributes, run by the `worker` role rather
 * than alongside the API.
 *
 * Separate processes on purpose: a poll loop and a request path have unrelated
 * failure modes and unrelated scaling needs, and a worker that wedges must not
 * take GraphQL down with it. It is also what lets a worker's database session
 * differ from a request's — the workflow worker presents `app.worker_role`,
 * which the API's request path never sets.
 */
export type ModuleWorker = {
  start(context: ModuleWorkerContext): ModuleWorkerHandle | Promise<ModuleWorkerHandle>;
};

export type RuntimeModule = {
  /** Must match the CompilerPlugin name of the same package. */
  name: string;
  /**
   * One-shot async setup, awaited before the process serves traffic.
   *
   * `graphql()` is synchronous — a schema cannot be built from a promise — so a
   * module that must read something before it can answer has nowhere else to do
   * it. The workflow module hydrates its node catalog here: without that, every
   * node type resolves to null and definition validation silently passes while
   * checking nothing, which is worse than failing.
   *
   * Throwing here is a load failure like any other: the module is recorded and
   * skipped rather than taking the process down.
   */
  init?(context: ModuleRuntimeContext): Promise<void>;
  graphql?(context: ModuleRuntimeContext): ModuleGraphqlContribution;
  /**
   * Register fastify routes. Called inside the same child plugin the core
   * routes use, so contributed routes are behind the rate limiter too.
   */
  restRoutes?(routes: FastifyInstance, context: ModuleRuntimeContext): void;
  /** Seed steps appended to the migration chain, in declaration order. */
  seeds?: ModuleSeed[];
  /**
   * Worker roles this module contributes, keyed by role name — the value
   * `OPENSHAPEFORGE_ROLE` selects. A role name colliding across two modules is
   * refused at boot rather than silently last-wins, exactly as a GraphQL field
   * name is.
   */
  workers?: Record<string, ModuleWorker>;
};
