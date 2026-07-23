# OpenShapeForge

An extensible, compiler-driven core ERP platform. Entities are authored as
YAML; a compiler generates everything downstream, and the runtimes are
generic engines driven by the generated artifacts.

From one entity YAML file you get:

- a Postgres schema with row-level security (multi-tenant by construction),
- a generic GraphQL CRUD API (queries, mutations, filters, sort, cursor
  pagination, relationship traversal),
- an append-only entity-event journal on every mutation,
- automatically derived e2e tests (with HTML reports) and k6 load tests.

Extensibility comes in three forms: Kustomize-style **authoring layers**
(base + overlays with strategic-merge entity patches), **compiler plugins**
(extra generators, platform tables, and authoring layers), and **host-repo
consumption** (run the compiler against another repository's authoring
config).

## Quickstart

```sh
bun install
docker compose -f docker-compose.local.yml up -d --build   # Postgres :5434, Keycloak :8181

bun run generate      # compile YAML -> schema.sql, manifest, realm, plugin artifacts
bun run db:migrate    # apply the schema (roll-forward, additive-safe)
bun run dev:api       # http://127.0.0.1:3001/api/graphql (GraphiQL in dev)

bun run check:generated && bun run test:e2e    # proof gates
bun run test:e2e:report                        # + HTML report in .e2e-report/
bun run test:perf                              # k6 load suite (brew install k6)
```

Copy `apps/api/.env.example` → `apps/api/.env` first; requests need a
Keycloak bearer token or signed trusted-context headers — see
[docs/api.md](docs/api.md).

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | YAML → compiler → artifacts → runtimes; determinism gates |
| [docs/authoring.md](docs/authoring.md) | Entity YAML anatomy, catalogs, adding an entity |
| [docs/layers.md](docs/layers.md) | Authoring layers, overlays, `entityPatch` merge semantics |
| [docs/plugins.md](docs/plugins.md) | Compiler plugin contract + shipped examples |
| [docs/api.md](docs/api.md) | CRUD engine, RLS, auth, event journal, local stack |
| [docs/testing.md](docs/testing.md) | Proof gates, e2e suite, reports, k6 |
| [docs/migrations.md](docs/migrations.md) | Roll-forward + versioned migrations, drift signals |
| [docs/consuming.md](docs/consuming.md) | Using the compiler from a host repo |
| [docs/README.md](docs/README.md) | Index of the above |

Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

OpenShapeForge is source-available for **non-commercial use only**. Commercial
licensing is not currently offered. See [LICENSE](LICENSE) for the exact
terms.
