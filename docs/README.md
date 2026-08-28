# OpenShapeForge documentation

OpenShapeForge is an extensible, compiler-driven core ERP platform: entities are
authored as YAML, and a compiler generates the Postgres schema (with RLS),
a runtime manifest that drives a generic GraphQL CRUD API, an entity-event
journal, and manifest-derived e2e + load tests. Start with
[architecture.md](architecture.md).

| Doc | Contents |
| --- | --- |
| [architecture.md](architecture.md) | The big picture: YAML → compiler → generated artifacts → runtimes; generated-vs-hand-written boundary; determinism gates |
| [authoring.md](authoring.md) | Entity YAML anatomy, `_base.yaml`, slug rules, catalogs, `authorization.yaml`, adding an entity end-to-end |
| [layers.md](layers.md) | `authoring.config.yaml`, overlays, `kind: entityPatch` strategic merge, catalog merging, `.authoring-build/` |
| [plugins.md](plugins.md) | The `CompilerPlugin` contract, `ownedPaths`, determinism rules, and both shipped examples (entity-docs, workflow) |
| [connectors.md](connectors.md) | Connector contracts, licensing and entitlement, configuration and secrets, the execution trust model |
| [api.md](api.md) | The generic CRUD engine, multi-tenancy + RLS, auth (Keycloak bearer / trusted-context HMAC), the entity-event journal, env + local stack |
| [operations.md](operations.md) | CORS ownership, persisted web operations, metrics/error privacy, readiness, OpenTelemetry, and GraphiQL |
| [mcp.md](mcp.md) | The generated MCP server: opting in, the tool catalog built from field definitions, per-session tool listing, classification handling |
| [testing.md](testing.md) | Proof gates, the manifest-derived e2e suite, HTML reports, the k6 perf suite |
| [migrations.md](migrations.md) | Roll-forward additive migrator, versioned bespoke migrations, drift signals, caveats |
| [consuming.md](consuming.md) | Using the compiler from a host repo; the web app; current limitations |

Also in this directory: **`entities.generated.md`** — the live reference of
every generated entity (columns + GraphQL operation names), produced by the
entity-docs example plugin. It is a **generated, gitignored** file: if it is
missing or stale, run `bun run generate`; never edit it by hand.
