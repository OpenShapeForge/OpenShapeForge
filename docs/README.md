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
| [plugins.md](plugins.md) | The `CompilerPlugin` contract, `ownedPaths`, determinism rules, and both shipped examples (entity-docs, notebook) |
| [maintenance.md](maintenance.md) | Trusted module maintenance: audited store lifecycle, scoped canonical Operations, explicit seed jobs and CLI |
| [jobs.md](jobs.md) | The durable job queue: `platform.jobs`, enqueue/claim/settle, `outcome_unknown`, the `job-worker` role, the `mail.deliver` kind and SMTP provider, the `jobs.*` Operations |
| [inbound-deliveries.md](inbound-deliveries.md) | Authenticated inbound provider webhooks: the bounded HMAC over exact bytes, tenant from a stored registration, the durable receipt, duplicate and crash handling, the plugin registration API and what a plugin still owes |
| [connectors.md](connectors.md) | Connector contracts, licensing and entitlement, configuration and secrets, the execution trust model |
| [identity-providers.md](identity-providers.md) | External identity providers: what OSF ships vs. what a host authors, the `keycloak.identityProviders` contract, Apple, validation rules, reconciling an existing realm, Keycloak/provider lockstep |
| [api.md](api.md) | The generic CRUD engine, multi-tenancy + RLS, auth (Keycloak bearer / trusted-context HMAC), the entity-event journal, env + local stack |
| [operations.md](operations.md) | CORS ownership, persisted web operations, metrics/error privacy, readiness, OpenTelemetry, and GraphiQL |
| [mcp.md](mcp.md) | The generated MCP server: opting in, the tool catalog built from field definitions, per-session tool listing, classification handling |
| [testing.md](testing.md) | Proof gates, the manifest-derived e2e suite, HTML reports, the k6 perf suite |
| [execution-policies.md](execution-policies.md) | Host-wide execution admission: `executionPolicies`, which Operations are governed, where it is decided (including inside the owning transaction and before a queued job's handler), the read-only decision boundary, fail-closed boot, composition, `EXECUTION_NOT_PERMITTED`, and the limits |
| [operation-availability.md](operation-availability.md) | Current record action availability: `operationAvailabilityHandlers`, batched offers, re-evaluation inside the write |
| [capability-grants.md](capability-grants.md) | Token-authorized Operations for recipients without an account: `auth.mode: capability`, the grant table, resolution into a grant session, attempt limits, issuing and revoking, audit |
| [migrations.md](migrations.md) | The migrate chain: build, additive roll-forward, versioned migrations, db:reset for development, the empty-database bootstrap, drift signals, caveats |
| [consuming.md](consuming.md) | Using the compiler from a host repo; the web app; current limitations |
| [field-acceptance-fixture.md](field-acceptance-fixture.md) | The opt-in 48-field fixture: the numbered value catalogue, the variable mode per field, who owns each contract, and the gaps the authoring contract does not cover |

Also in this directory: **`entities.generated.md`** — the live reference of
every generated entity (columns + GraphQL operation names), produced by the
entity-docs example plugin. It is a **generated, gitignored** file: if it is
missing or stale, run `bun run generate`; never edit it by hand.
