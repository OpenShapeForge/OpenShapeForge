// SPDX-License-Identifier: BUSL-1.1
/**
 * Compiler plugin system.
 *
 * A plugin extends the compiler without living in it: extra generators (e.g.
 * a future workflow-contract plugin), extra platform tables, and optionally
 * its own authoring layer (a package shipping `authoring/**` next to its
 * code — appended to the configured layers automatically).
 *
 * Registration happens in `authoring.config.yaml`:
 *
 *   plugins:
 *     - ./examples/plugins/entity-docs.ts     # local module
 *     - "@openshapeforge/plugin-workflow"         # workspace/npm package
 *
 * A plugin module default-exports a `CompilerPlugin`. Hooks must be pure and
 * deterministic — `check:generated` runs the whole pipeline twice and fails
 * on any hash difference, plugins included.
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { CompiledEntityContract } from "./authoring/types.js";
import { loadAuthoringConfig } from "./authoring/layers.js";
import type { GeneratedArtifact, PlatformSchemaManifest, TableDefinition } from "./schema.js";

export type CompiledEntityInfo = {
  slug: string;
  /** Repo-root-relative provenance path of the entity YAML. */
  path: string;
  origin: "core" | "contextFull";
  contract: CompiledEntityContract;
};

export type PluginBaseContext = {
  repoRoot: string;
  authoringDir: string;
  webPresent: boolean;
};

export type PluginGenerateContext = PluginBaseContext & {
  manifest: PlatformSchemaManifest;
  entities: CompiledEntityInfo[];
};

export type PluginSchemaMigration = {
  /** Plugin-local immutable migration version, e.g. `0100_install-triggers`. */
  version: string;
  /** PostgreSQL DDL applied after the generated tables exist. */
  sql: string;
};

export type JsonSchema = Record<string, unknown>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PluginOperationError = {
  status: number;
  code: string;
  description: string;
  schema?: JsonSchema;
  /**
   * REST projection metadata. A body is an optional fixed representation for
   * a matching platform-raised error (for example an authorization rejection
   * raised before the module handler runs). Handler-returned errors supply
   * their own body using this declared content type.
   */
  rest?: {
    body?: JsonValue;
    contentType?: string;
  };
};

export type PluginOperationAuth =
  | { mode: "public" }
  | { mode: "session"; roles: string[]; scopes?: string[] }
  | {
      mode: "custom";
      /** OpenAPI components.securitySchemes key. */
      scheme: string;
      description: string;
      securityScheme:
        | { type: "apiKey"; in: "header" | "query" | "cookie"; name: string }
        | { type: "http"; scheme: string; bearerFormat?: string };
    };

export type DisabledOperationProjection = {
  enabled: false;
  /** Why this canonical operation cannot be represented honestly on the transport. */
  reason: string;
};

export type PluginOperationContract = {
  /** Stable, globally unique key. Prefix with the plugin name, e.g. `workflow.instance.start`. */
  key: string;
  title: string;
  description: string;
  /** Key in the runtime module's `operationHandlers` map. */
  handler: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  errors: PluginOperationError[];
  auth: PluginOperationAuth;
  tenancy: {
    mode: "required" | "derived" | "none";
    description?: string;
  };
  idempotency: {
    mode: "none" | "intrinsic" | "idempotency-key";
    header?: string;
    /** Canonical input property populated from the REST header and supplied directly by other transports. */
    inputField?: string;
    description?: string;
  };
  transports: {
    rest: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      /**
       * Deprecated compatibility paths dispatched through this operation's
       * canonical handler and transport contract. The compiler collision-audits
       * these paths; they are never independent operations.
       */
      aliases?: string[];
      path: string;
      response: {
        /** Successful REST status; defaults to 200 when omitted. */
        status?: number;
        kind: "json" | "binary" | "stream";
        contentType?: string;
      };
    };
    mcp:
      | { enabled: true; name: string }
      | DisabledOperationProjection;
    graphql:
      | { enabled: true; kind: "query" | "mutation"; field: string }
      | DisabledOperationProjection;
    typescript: { enabled: true; functionName: string } | DisabledOperationProjection;
  };
};

export type CompilerPlugin = {
  name: string;
  /** Canonical command/query contracts projected into every supported transport. */
  operations?:
    | PluginOperationContract[]
    | ((context: PluginBaseContext) => PluginOperationContract[]);
  /**
   * Extra platform tables merged into the base manifest before authoring
   * entities are promoted (e.g. a workflow plugin's catalog/instance tables).
   * Colliding with an existing schema.table is an error.
   */
  contributePlatformTables?(context: PluginBaseContext): TableDefinition[];
  /**
   * Versioned DDL for invariants that are not table constraints, such as
   * functions and triggers. Applied after generated tables and checksum-locked
   * in the shared migration ledger.
   */
  schemaMigrations?:
    | PluginSchemaMigration[]
    | ((context: PluginBaseContext) => PluginSchemaMigration[]);
  /** Emit artifacts; paths are repo-root-relative like all compiler output. */
  generate?(
    context: PluginGenerateContext,
  ): GeneratedArtifact[] | Promise<GeneratedArtifact[]>;
  /**
   * Generated paths this plugin owns, so `check:generated` extends its
   * stale/orphan gates to them.
   */
  ownedPaths?: { roots?: string[]; files?: string[] };
};

/**
 * A loaded plugin plus where it came from. The specifier is what the runtime
 * module registry is derived from — see `generate-modules.ts` — so it has to
 * survive loading, and it is deliberately NOT part of `CompilerPlugin`: a
 * plugin author declares hooks, not their own provenance.
 */
export type LoadedCompilerPlugin = {
  plugin: CompilerPlugin;
  /** Exactly as written in authoring.config.yaml. */
  spec: string;
  /** Absolute path the specifier resolved to. */
  modulePath: string;
};

function resolvePluginModulePath(repoRoot: string, spec: string): string {
  if (spec.startsWith(".") || isAbsolute(spec)) {
    const asPath = isAbsolute(spec) ? spec : resolve(repoRoot, spec);
    if (existsSync(asPath)) {
      return asPath;
    }
    throw new Error(`Plugin module "${spec}" not found (resolved to ${asPath}).`);
  }
  try {
    return Bun.resolveSync(spec, repoRoot);
  } catch (error) {
    throw new Error(`Plugin package "${spec}" could not be resolved: ${String(error)}`);
  }
}

function assertPluginShape(spec: string, plugin: unknown): CompilerPlugin {
  const candidate = plugin as CompilerPlugin | undefined;
  if (!candidate || typeof candidate.name !== "string" || !candidate.name) {
    throw new Error(`Plugin "${spec}" must default-export an object with a string "name".`);
  }
  return candidate;
}

const pluginCache = new Map<string, Promise<LoadedCompilerPlugin[]>>();

/** Loaded plugins with their provenance. Memoized per repo root. */
export function loadCompilerPluginEntries(
  repoRoot: string,
): Promise<LoadedCompilerPlugin[]> {
  let cached = pluginCache.get(repoRoot);
  if (!cached) {
    cached = (async () => {
      const { plugins = [] } = loadAuthoringConfig(repoRoot);
      const loaded: LoadedCompilerPlugin[] = [];
      const seen = new Set<string>();
      for (const spec of plugins) {
        const modulePath = resolvePluginModulePath(repoRoot, spec);
        const module = (await import(modulePath)) as { default?: unknown };
        const plugin = assertPluginShape(spec, module.default);
        if (seen.has(plugin.name)) {
          throw new Error(`Duplicate compiler plugin name "${plugin.name}".`);
        }
        seen.add(plugin.name);
        loaded.push({ plugin, spec, modulePath });
      }
      return loaded;
    })();
    pluginCache.set(repoRoot, cached);
  }
  return cached;
}

export async function loadCompilerPlugins(repoRoot: string): Promise<CompilerPlugin[]> {
  return (await loadCompilerPluginEntries(repoRoot)).map((entry) => entry.plugin);
}

/** Merge plugin-contributed platform tables into the base manifest (in place). */
export function mergePluginPlatformTables(
  baseManifest: PlatformSchemaManifest,
  plugins: CompilerPlugin[],
  context: PluginBaseContext,
): void {
  const existing = new Set(baseManifest.tables.map((table) => `${table.schema}.${table.name}`));
  for (const plugin of plugins) {
    for (const table of plugin.contributePlatformTables?.(context) ?? []) {
      const key = `${table.schema}.${table.name}`;
      if (existing.has(key)) {
        throw new Error(
          `Plugin "${plugin.name}" contributes platform table ${key}, which already exists.`,
        );
      }
      existing.add(key);
      // Ownership is material only when the table uses the new invariant
      // contract. Leaving legacy contributed tables untouched preserves their
      // manifest checksum and every generated byte.
      baseManifest.tables.push(
        (table.constraints?.length ?? 0) > 0
          ? { ...table, pluginOwner: plugin.name }
          : table,
      );
    }
  }
}
