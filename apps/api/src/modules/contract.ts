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

export type RuntimeModule = {
  /** Must match the CompilerPlugin name of the same package. */
  name: string;
  graphql?(context: ModuleRuntimeContext): ModuleGraphqlContribution;
  /**
   * Register fastify routes. Called inside the same child plugin the core
   * routes use, so contributed routes are behind the rate limiter too.
   */
  restRoutes?(routes: FastifyInstance, context: ModuleRuntimeContext): void;
  /** Seed steps appended to the migration chain, in declaration order. */
  seeds?: ModuleSeed[];
};
