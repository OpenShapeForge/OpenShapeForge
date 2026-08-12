<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <img src="docs/assets/logo.svg" alt="OpenShapeForge logo" width="96" height="96">
</picture>

# OpenShapeForge

An extensible, compiler-driven core ERP platform. Entities are authored as
YAML; a compiler generates everything downstream, and the runtimes are
generic engines driven by the generated artifacts.

From one entity YAML file you get:

- a Postgres schema with row-level security (multi-tenant by construction),
- a generic GraphQL CRUD API (queries, mutations, filters, sort, cursor
  pagination, relationship traversal),
- an MCP server whose tool schemas carry the authored validation, enumerations,
  and labels, so agents get the constraints up front,
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
cp apps/api/.env.example apps/api/.env                      # required before db:migrate/dev:api; defaults match the compose stack
docker compose -f docker-compose.local.yml up -d --build   # Postgres :5434, Keycloak :8181

bun run generate      # compile YAML -> schema.sql, manifest, realm, CRUD pages, plugin artifacts
bun run db:migrate    # apply the schema (roll-forward, additive-safe)
bun run dev:api       # http://127.0.0.1:3001/api/graphql (GraphiQL in dev)
bun run dev:web       # http://localhost:3000 — the generated CRUD app

bun run check:generated && bun run test:e2e    # proof gates
bun run test:e2e:report                        # + HTML report in .e2e-report/
# Performance gate: restart dev:api with this checked, local-only profile,
# then run k6 from another terminal (brew install k6).
HOST=127.0.0.1 API_RATE_LIMIT_MAX=600 API_RATE_LIMIT_MAX_TRUSTED=1000000 bun run dev:api
bun run test:perf
```

Requests need a Keycloak bearer token or signed trusted-context headers — see
[docs/api.md](docs/api.md).

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | YAML → compiler → artifacts → runtimes; determinism gates |
| [docs/authoring.md](docs/authoring.md) | Entity YAML anatomy, catalogs, adding an entity |
| [docs/layers.md](docs/layers.md) | Authoring layers, overlays, `entityPatch` merge semantics |
| [docs/plugins.md](docs/plugins.md) | Compiler plugin contract + shipped examples |
| [docs/connectors.md](docs/connectors.md) | Connector contracts: one YAML interface, many surfaces, license-gated |
| [docs/api.md](docs/api.md) | CRUD engine, RLS, auth, event journal, local stack |
| [docs/mcp.md](docs/mcp.md) | Generated MCP server: tools from field definitions, authorization |
| [docs/testing.md](docs/testing.md) | Proof gates, e2e suite, reports, k6 |
| [docs/migrations.md](docs/migrations.md) | Roll-forward + versioned migrations, drift signals |
| [docs/consuming.md](docs/consuming.md) | Using the compiler from a host repo |
| [docs/README.md](docs/README.md) | Index of the above |

Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

OpenShapeForge is **source-available** under the
[Business Source License 1.1](LICENSE) (BUSL-1.1). In plain terms:

- You may copy, modify, redistribute, and make non-production use of this
  software — for example development, testing, and evaluation.
- **Any production use requires a commercial license from BatterAI B.V.**
  This includes internal production deployments and applies to all
  organizations alike: companies, non-profits, governments, educational and
  other institutions.
- On the Change Date — at the latest four years after a version is
  published — that version automatically and irrevocably becomes available
  under the [GNU AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html).
  Converted versions remain copyleft: if you convey a modified version, or
  let users interact with one over a network, you must offer those users its
  corresponding source (AGPLv3 §13).

This summary is informational only; the [LICENSE](LICENSE) file contains the
binding terms.
