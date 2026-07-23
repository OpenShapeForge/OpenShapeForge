# Implementation Spec — Wire `authorization.rowAccess` into emitted RLS policies

**Status:** design, implementation-ready
**Security finding closed:** the entity-level `authorization.rowAccess` vocabulary is compiled and validated (`packages/compiler/src/authoring/compiler/authorization.ts:149-211`) but never translated into `TableDefinition.rowScope`, so declared owner/group confidentiality emits **no** DB policy; and the runtime `scope` is dropped because `GraphqlSessionContext` has no `scope` field (`apps/api/src/graphql/context.ts:4-14`), so `normalizeScope(undefined)` always yields `'self'` (`apps/api/src/db/session.ts:63-66`).
**Goal:** full owner + group row-level access, enforced by Postgres RLS (`FORCE ROW LEVEL SECURITY`), with DB-layer proof tests.

---

## 0. Current state (code-grounded)

### 0.1 The RLS emitter is complete and tested — nothing feeds it
`renderRowScopePredicate` (`packages/compiler/src/generate.ts:134-173`) already emits the exact multi-axis policy we need:

- `bypassRoles` → `app.has_scope('tenant')` branch (`generate.ts:141-143`).
- `group` → `"{col}" = ANY (app.current_groups())`, validating the column exists (`generate.ts:144-152`).
- `userColumns[]` → each `"{col}" = app.current_user_id()`, validating each column (`generate.ts:153-161`).
- tenant predicate always `tenant_id = app.current_tenant()` (`generate.ts:164`).
- final shape: `app.bypass_rls() OR ({tenant} AND ({branches joined by OR}))` (`generate.ts:172`); degenerate no-axis case → `app.bypass_rls() OR ({tenant})` (`generate.ts:166-170`).
- `deriveRowScopeIndexes` emits `(tenant_id, {group.column})` and partial `(tenant_id, {userColumn}) WHERE "{userColumn}" IS NOT NULL` indexes (`generate.ts:175-200`).
- `renderTableSql` chooses `{table}_row_scope` policy when `table.rowScope` is set, else `{table}_tenant_isolation` (`generate.ts:221-247`).

The `RowScopePolicy` type (`packages/compiler/src/schema.ts:52-84`) and the validated hand-authored loader `loadRowScope` (`packages/compiler/src/load-manifest.ts:191-257`) are the **only** current producer of `rowScope`. No entity-authored path exists.

### 0.2 The compiler validates `rowAccess` then throws the result away
`buildAuthorization` (`authorization.ts:149-211`) produces `CompiledAuthorization.rowAccess` (`packages/compiler/src/authoring/types/compiled.ts:392-404`): `{ enabled, empty: "public"|"restricted", owner?: { column, session } }`. It validates that `owner.column` is a uuid persisted field or a `belongsTo.foreignKey` (`authorization.ts:166-191`) and `owner.session` is non-empty (`authorization.ts:192-197`). It has **no group axis**.

`backend-manifest.ts` builds every `TableDefinition` (`backend-manifest.ts:612-772`) and **never reads `candidate.contract.authorization.rowAccess`** (confirmed: `grep rowScope backend-manifest.ts` → none). `tenantScoped` is derived only from `authorization !== undefined` (`backend-manifest.ts:625`). This is the exact break: the compiled owner/group intent is dropped, and every entity emits plain `{table}_tenant_isolation`.

### 0.3 The 3 shipped entities (regression baseline)
`relation.yaml`, `relation-group.yaml`, `contact-detail.yaml` all declare `rowAccess: { enabled: true, empty: public }` with **no owner, no group**. Generated output today (`apps/api/src/generated/db/schema.sql:143-173`) is plain `{table}_tenant_isolation` with `USING (tenant_id = app.current_tenant())`. **These three must stay byte-identical** after this change (see §C, §F determinism test).

### 0.4 Runtime scope drop (F5)
- `resolveSessionContext` computes `scope` correctly (`identity.ts:73-78, 119`): `tenant` if a bypass role matches, else `group` if groups present, else `self`. `TrustedSessionContext` carries it.
- `createGraphqlContext` copies `tenantId/userId/roles/groups` into `GraphqlSessionContext` but **drops `scope`** (`context.ts:30-35`). The type has no `scope` field (`context.ts:4-14`).
- Resolvers pass `context.session` straight through as `DbSessionInput` (`generated-entity-schema.ts:220,239,261,271,282`; `generated-crud.ts` signatures at `:258,303,318,378,418,464,496`).
- `createDbSessionContext` → `normalizeScope(input.scope)` → `input.scope` is `undefined` → returns `"self"` (`session.ts:63-66,84`). So `app.scope` GUC (`session.ts:96`) is always `'self'`, and `app.has_scope('tenant')` never fires.

### 0.5 No org-unit / closure model exists
Repo has 3 commits total. `erp.org_unit_closure` and "login resolver" are referenced only in **comments** describing an upstream system that was stripped (`schema.ts:66-68`, `identity.ts:96-100`, `storage.ts:38`). There is **no** org_unit table, no closure table, no group-resolution code. `app.current_groups()` reads the `app.user_groups` GUC (`app-helpers.ts:28-34`); `normalizeGroups` already filters token groups to UUIDs and caps at `MAX_SESSION_GROUPS=256` (`session.ts:45-61`). The group subsystem must be designed fresh and minimal.

---

## A. Authoring vocabulary

### A.1 Owner (exists) — no authoring change
`authorization.rowAccess.owner { column, session }` stays as-is. Already schema-defined (`core-entity.schema.json:192-207`) and validated (`authorization.ts:166-197`).

### A.2 Group (new axis)
Add `authorization.rowAccess.group { column, expand }` where `expand ∈ { descendants | ancestors | exact }` (default `descendants`). Mirrors `RowScopePolicy.group` (`schema.ts:57-72`) and the loader vocabulary (`load-manifest.ts:189`).

- `column`: persisted uuid field OR `belongsTo.foreignKey` on the entity that holds the row's owning org-unit id (validated identically to `owner.column`).
- `expand`: metadata for the session-setup resolver, NOT the policy (the policy always compares to the already-expanded `app.current_groups()` — see §E). Carried through to `RowScopePolicy.group.expand` for documentation/index parity only.

**Decision:** `owner` and `group` are **independently combinable** on one entity (both emit OR-branches — matches the emitter's OR semantics at `generate.ts:172`). Rejected: mutually-exclusive modes (the compiled type's `owner?` currently implies exclusivity, but the DB emitter already OR-combines axes, so exclusivity would be an artificial authoring restriction).

### A.3 JSON-schema additions

**`core-entity.schema.json`** — inside `properties.authorization.properties.rowAccess.properties`, alongside `owner` (`core-entity.schema.json:192`), add:

```json
"group": {
  "type": "object",
  "description": "Group-predicated mode. The generated RLS policy adds `\"<column>\" = ANY(app.current_groups())`. Use for org-unit / team confidentiality. The column must be a uuid field or belongsTo foreignKey holding the row's owning org-unit id.",
  "additionalProperties": false,
  "required": ["column"],
  "properties": {
    "column": {
      "type": "string",
      "description": "Persisted uuid column (or belongsTo foreignKey) on this entity holding the owning org-unit id."
    },
    "expand": {
      "type": "string",
      "enum": ["descendants", "ancestors", "exact"],
      "default": "descendants",
      "description": "How the user's directly-bound org units expand against the closure at session setup: descendants=see rows of child units, ancestors=see parents', exact=only direct units. Resolved into app.current_groups() before the query; the policy compares to the already-expanded set."
    }
  }
}
```

Also revise the stale `rowAccess.description` and `empty.description` text (they reference the removed `entity_row_access` table): change `empty.description` to `"Behavior when a row's group/owner column IS NULL: 'public' = the NULL-column row is visible tenant-wide (OR-NULL branch emitted); 'restricted' = NULL-column rows are hidden. Defaults to 'public'. Forced to 'restricted' when 'owner' is set."`

**`authorization-config.schema.json`** — **no change required.** That schema governs realm/client/group Keycloak config, not entity `rowAccess`. (Grep confirms entity `rowAccess` lives only in `core-entity.schema.json`.) The org-unit → Keycloak group mapping for dev seeds reuses the existing `groups` / `users[].groups` vocabulary already present there.

### A.4 Compiled + authoring TS types

**`packages/compiler/src/authoring/types/common.ts`** — extend `RowAccessConfig` (`common.ts:75-79`):

```ts
export interface RowAccessGroupConfig {
  column: string;
  expand?: "descendants" | "ancestors" | "exact";
}
export interface RowAccessConfig {
  enabled: boolean;
  empty?: "public" | "restricted";
  owner?: RowAccessOwnerConfig;
  group?: RowAccessGroupConfig; // NEW
}
```

**`packages/compiler/src/authoring/types/compiled.ts`** — extend `CompiledAuthorization.rowAccess` (`compiled.ts:392-404`):

```ts
rowAccess?: {
  enabled: boolean;
  empty: "public" | "restricted";
  owner?: { column: string; session: string };
  group?: { column: string; expand: "descendants" | "ancestors" | "exact" }; // NEW, expand defaulted
};
```

---

## B. Compiler translation rules (`CompiledAuthorization.rowAccess` → `TableDefinition.rowScope`)

### B.1 Owner session handling — **DECISION: constrain owner to `app.current_user_id()` (option i)**

`RowScopePolicy.userColumns` emits `"{col}" = app.current_user_id()` with the session var **hardcoded** (`generate.ts:160`). Two options were on the table:

- **(i) [CHOSEN]** Constrain the entity owner axis to the identity user id: map `owner.column` → `rowScope.userColumns = [owner.column]`, and **require `owner.session === "app.current_user_id"`** at compile time. Rationale: the runtime only ever sets `app.user_id` (`session.ts:93`) — no code sets an arbitrary `app.current_account_id` GUC anywhere; the emitter, indexes (`generate.ts:191-197`), and the whole tested pipeline already assume `app.current_user_id()`. Zero emitter/type churn.
- **(ii) [REJECTED]** Extend `RowScopePolicy` with a per-column session var and teach `renderRowScopePredicate` to emit `"{col}" = nullif(current_setting('{session}',true),'')::uuid`. Rejected one-liner: it adds an untested SQL surface and a GUC (`app.current_account_id`) that nothing in the runtime populates, so it would ship dead.

**Compiler rule:** in `buildAuthorization`, when `owner` is present, additionally assert `owner.session === "app.current_user_id"` (or normalize a small allowlist `{ "app.current_user_id" }`) and throw `AuthorizationCompileError` otherwise, with message: `authorization.rowAccess.owner.session must be "app.current_user_id" — the runtime only exposes the current user id GUC. Per-account session vars are not supported.` This tightens `authorization.ts:192-197`. Update the 0 shipped owner-entities: none exist, so no migration.

> If the product later needs a distinct account axis, revisit as option (ii) behind a new emitter test — out of scope here.

### B.2 `empty` semantics — **DECISION: `public` ⇒ OR-NULL branch; `restricted` ⇒ no branch (NULL hidden)**

The emitter today has **no `empty`/OR-NULL concept** — a row whose `owner`/`group` column is NULL matches no axis branch and is hidden. That is exactly `empty: restricted`. For `empty: public` we must emit an extra "column IS NULL" branch so unowned rows stay visible.

**Emitter extension** (`RowScopePolicy` + `renderRowScopePredicate`):

`RowScopePolicy` (`schema.ts:52-84`) — add optional flags carrying the OR-NULL intent per axis:

```ts
export type RowScopePolicy = {
  group?: { column: string; expand?: "descendants" | "ancestors" | "exact"; publicWhenNull?: boolean };
  userColumns?: string[];
  /** Owner/group columns whose NULL rows are visible tenant-wide (empty:public). */
  nullVisibleColumns?: string[];
  bypassRoles?: string[];
};
```

**Decision:** use a single `nullVisibleColumns: string[]` list (columns whose NULL value should emit an extra `"{col}" IS NULL` OR-branch) rather than per-axis booleans. Rejected one-liner: per-axis `publicWhenNull` booleans duplicate logic across the group and user loops; one flat list is emitted uniformly.

`renderRowScopePredicate` change (`generate.ts:134-173`): after building `branches`, for each `col` in `scope.nullVisibleColumns ?? []` (validating presence exactly like the other axes, `generate.ts:145-161`) push `` `${quoteIdent(col)} IS NULL` `` into `branches`. Everything else (bypass, tenant wrap, `app.bypass_rls()` prefix) is unchanged. Net effect for `empty: public` on an owner entity:

```
app.bypass_rls() OR (tenant_id = app.current_tenant() AND ("owner_id" = app.current_user_id() OR "owner_id" IS NULL))
```

For `empty: restricted` (`nullVisibleColumns` empty): the NULL branch is absent → unowned rows hidden.

> Note: `deriveRowScopeIndexes` (`generate.ts:175-200`) already emits `WHERE "{userColumn}" IS NOT NULL` partial indexes; the `IS NULL` branch is cheap (planner uses a separate scan) and does not need its own index at current data volumes. Documented, not indexed.

### B.3 The exact mapping in `backend-manifest.ts`

Insertion point: inside the `tables = candidates.map(...)` callback (`backend-manifest.ts:612-772`), **after** `columns` / relationship FK columns are finalized (after `backend-manifest.ts:713`, where every column incl. auto tenant_id and FK-typed owner/group columns exists) and **before** the `return { schema, name, ... }` object (`backend-manifest.ts:720`). At that point `candidate.contract.authorization?.rowAccess` and `columnsByName` (`backend-manifest.ts:715`) are both in scope.

Add a helper `deriveRowScope(candidate, columnsByName, tenantScoped): RowScopePolicy | undefined` and thread its result into the returned `TableDefinition` as `...(rowScope ? { rowScope } : {})`.

```ts
function deriveRowScope(
  rowAccess: CompiledAuthorization["rowAccess"],
  entityName: string,
  columnsByName: Map<string, ColumnDefinition>,
): RowScopePolicy | undefined {
  if (!rowAccess?.enabled) return undefined;

  const userColumns: string[] = [];
  const nullVisibleColumns: string[] = [];
  let group: RowScopePolicy["group"] | undefined;

  const requireColumn = (col: string, axis: string) => {
    const c = columnsByName.get(col);
    if (!c) {
      throw new Error(
        `[${entityName}] authorization.rowAccess.${axis} column "${col}" is declared but ` +
          `no matching column was emitted (check the persisted field or belongsTo foreignKey).`,
      );
    }
    if (c.type !== "uuid") {
      throw new Error(
        `[${entityName}] authorization.rowAccess.${axis} column "${col}" must be uuid, found ${c.type}.`,
      );
    }
  };

  if (rowAccess.owner) {
    requireColumn(rowAccess.owner.column, "owner.column");
    userColumns.push(rowAccess.owner.column);
    if (rowAccess.empty === "public") nullVisibleColumns.push(rowAccess.owner.column);
  }
  if (rowAccess.group) {
    requireColumn(rowAccess.group.column, "group.column");
    group = { column: rowAccess.group.column, expand: rowAccess.group.expand ?? "descendants" };
    if (rowAccess.empty === "public") nullVisibleColumns.push(rowAccess.group.column);
  }

  // No restriction axis declared → plain tenant scoping (documented no-op).
  if (userColumns.length === 0 && !group) return undefined;

  return {
    ...(group ? { group } : {}),
    ...(userColumns.length > 0 ? { userColumns } : {}),
    ...(nullVisibleColumns.length > 0 ? { nullVisibleColumns } : {}),
    // bypassRoles wired in a later phase (see §E.3 note); omitted for now.
  };
}
```

Call site (after `backend-manifest.ts:713`, before the return at `:720`):

```ts
const rowScope = deriveRowScope(
  candidate.contract.authorization?.rowAccess,
  candidate.contract.entity.name,
  columnsByName, // the map at backend-manifest.ts:715 (columnsByNameWithOperational)
);
```

and in the returned object (`backend-manifest.ts:720-771`) add `...(rowScope ? { rowScope } : {})`.

**Regression for the 3 shipped entities:** their `rowAccess = { enabled: true, empty: "public" }` has no `owner`, no `group` → `deriveRowScope` returns `undefined` → `TableDefinition.rowScope` stays unset → `renderTableSql` takes the `else` branch → identical `{table}_tenant_isolation` output. Byte-identical, satisfied.

---

## C. Fail-closed rules

**Principle:** the compiler MUST throw if `authorization.rowAccess` declares a *restriction* that does not result in an emitted policy. A restriction = any of `{ owner set, group set, empty: "restricted" }`.

Two layers, both fail at **compile time** (build fails, no SQL emitted):

1. **Column-existence fail-closed (backend-manifest, `deriveRowScope`):** if `owner`/`group` column is missing from the emitted columns or is not uuid → throw (see `requireColumn` above). This catches the case where a `belongsTo` FK was skipped as cross-module-unregistered (`backend-manifest.ts:702-707`) and the owning column silently never materialized.

2. **`empty: restricted` without an axis (backend-manifest, after `deriveRowScope`):** `empty: restricted` means "hide NULL-column rows" but only makes sense when there IS a group/owner column to be NULL. If `rowAccess.empty === "restricted"` **and** `!rowAccess.owner && !rowAccess.group`, throw:

```ts
if (rowAccess?.enabled && rowAccess.empty === "restricted" && !rowAccess.owner && !rowAccess.group) {
  throw new Error(
    `[${entityName}] authorization.rowAccess.empty: restricted requires an owner or group axis — ` +
      `otherwise the entity has no confidentiality column and "restricted" would hide every row ` +
      `or silently degrade to tenant scoping. Add an owner/group axis or set empty: public.`,
  );
}
```

This is the load-bearing guard: it converts a silent "declared confidential but emits nothing" into a hard build failure.

**Today's `empty: public` + no-owner + no-group entities** are explicitly **not** a restriction → they compile to plain tenant scoping (documented no-op). Assert this in a comment at the `deriveRowScope` early-return and in the determinism test (§F).

> Owner/group column-validation *also* runs earlier in `authorization.ts` (`:176-191`) against the authoring field list. Keep that (better error locality — points at the YAML). The backend-manifest guard is the belt-and-suspenders that catches the emit-time gap (FK skipped, column renamed by storage compiler). Both must exist.

---

## D. Group data model (minimal viable)

### D.1 Tables (hand-authored in `platform-schema.yaml`)

**DECISION: two tables — `platform.org_unit` + `platform.org_unit_closure` — authored in `packages/compiler/config/platform-schema.yaml`, maintained by a versioned trigger migration.** Rejected alternatives, one line each:
- *New authoring entities under `entities/core/`*: rejected — would inflate the shipped 3-entity slice, gain generated CRUD/GraphQL surface, and need their own authorization block; org units are platform infrastructure, not tenant business entities.
- *Recursive-CTE-at-read (no closure table)*: rejected — pushes a recursive CTE into every RLS policy evaluation (per-row, not InitPlan-hoistable), violating the STABLE-function performance contract in `app-helpers.ts:4-13`. A closure table keeps `app.current_groups()` a flat array compared with `= ANY(...)`.

`platform-schema.yaml` additions (mirrors `entity_events` shape at `platform-schema.yaml:24-42`):

```yaml
  - schema: platform
    name: org_unit
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true, default: gen_random_uuid() }
      - { name: tenant_id, type: uuid, required: true }
      - { name: parent_id, type: uuid }          # nullable → roots
      - { name: name, type: text, required: true }
      - { name: created_at, type: timestamptz, required: true, default: now() }
      - { name: updated_at, type: timestamptz, required: true, default: now() }
    indexes:
      - name: org_unit_tenant_parent_idx
        columns: [tenant_id, parent_id]
    # NOTE: parent_id FK to platform.org_unit(id) is same-schema → auto-emitted
    # by renderColumnForeignKeySql; add a self-reference via a `references` on
    # the column if the compiler requires it (it does for FK emission):
    #   - { name: parent_id, type: uuid, references: { schema: platform, table: org_unit, column: id, onDelete: RESTRICT } }

  - schema: platform
    name: org_unit_closure
    tenantScoped: true
    columns:
      - { name: tenant_id, type: uuid, required: true }
      - { name: ancestor_id, type: uuid, required: true }
      - { name: descendant_id, type: uuid, required: true }
      - { name: depth, type: integer, required: true }
      - { name: id, type: uuid, primaryKey: true, default: gen_random_uuid() }
    indexes:
      - name: org_unit_closure_ancestor_idx
        columns: [tenant_id, ancestor_id]
        unique: false
      - name: org_unit_closure_descendant_idx
        columns: [tenant_id, descendant_id]
      - name: org_unit_closure_edge_uk
        columns: [tenant_id, ancestor_id, descendant_id]
        unique: true
```

Both are `tenantScoped: true`, so the generated emitter (`generate.ts:221-246`) gives each a `{table}_tenant_isolation` policy automatically — they are themselves RLS'd by tenant. **They do NOT get a `rowScope`** (they are the resolution substrate; a user must be able to read the closure for their own tenant to expand groups — tenant isolation is the correct and sufficient boundary). The org-unit expansion query at session setup runs under the normal tenant GUC.

Closure semantics: standard transitive-closure table. Self-row `(u,u,0)` for every unit; `(a,d,k)` for every ancestor `a` of `d` at distance `k`. `descendants(x)` = `SELECT descendant_id FROM org_unit_closure WHERE ancestor_id = x`; `ancestors(x)` = `SELECT ancestor_id FROM org_unit_closure WHERE descendant_id = x`.

### D.2 Maintenance strategy — **DECISION: a Postgres trigger on `platform.org_unit`, shipped as a versioned bespoke migration**

Rejected: app-maintained closure (rejected one-liner: splits the invariant across TS write paths and risks drift if any writer bypasses the service; the trigger keeps it atomic with the row write regardless of writer). The trigger is authored under `apps/api/src/db/migrations/versioned/` (registered in `versioned/index.ts` — pattern at `migration-chain.ts` step 3, runs before the generated roll-forward so the closure trigger exists before any org_unit seed insert).

Trigger contract (INSERT/UPDATE of `parent_id`/DELETE on `org_unit`):
- **INSERT:** insert self-row `(tenant_id, NEW.id, NEW.id, 0)`; then `INSERT ... SELECT ancestor_id, NEW.id, depth+1 FROM org_unit_closure WHERE descendant_id = NEW.parent_id` (copy parent's ancestor paths, +1 depth).
- **UPDATE of parent_id:** delete the subtree's edges that cross the moved node, re-link under the new parent (standard closure reparent: delete `WHERE descendant_id IN (subtree) AND ancestor_id NOT IN (subtree)`, then reinsert cross-product of new-parent ancestors × subtree). Keep it correct-but-simple; document the reparent SQL inline.
- **DELETE:** `ON DELETE RESTRICT` on `parent_id` FK plus closure rows removed for the deleted node; require children reparented/removed first (RESTRICT enforces this).

All trigger DML runs `SECURITY DEFINER` or under the migrate role so it is not itself blocked by RLS while still writing `tenant_id` from `NEW.tenant_id` (never cross-tenant — assert `NEW.tenant_id = OLD.tenant_id` on update).

---

## E. GUC / runtime contract

### E.1 Group expansion location — **DECISION: expand at session setup, store the EXPANDED set in `app.user_groups`**

`app.current_groups()` returns the raw `app.user_groups` GUC array (`app-helpers.ts:28-34`). **Decision: the caller expands the user's direct org-unit UUIDs against the closure per the entity's `expand` mode BEFORE `withDbSession`, and `app.user_groups` holds the already-expanded set.** The policy stays a flat `= ANY(app.current_groups())` (`generate.ts:151`) — no closure join inside the hot policy path. Rejected one-liner: expanding inside the policy (a subquery/CTE against the closure per row) defeats the InitPlan hoisting the STABLE-function design depends on (`app-helpers.ts:4-13`).

**Subtlety — `expand` is per-entity but `app.user_groups` is per-session.** A session can face entities with different `expand` modes. Resolution: the closure is symmetric enough that we store the **descendants-expansion** (the common case, default) in `app.user_groups`, and:
- `descendants` entities compare directly (correct).
- `exact` entities: the emitter would need to compare against the *unexpanded* set. **Decision for Phase 2 scope:** support `descendants` and `exact` by storing BOTH the raw direct set (`app.user_groups_direct`) and the descendant-expanded set (`app.user_groups`), and add `app.current_groups_exact()` returning the direct set. `ancestors` mode is deferred (documented open question §Risks) because it inverts the expansion and is not needed by any current entity. For Phase 2 we ship `descendants` (default) end-to-end; `exact` is a thin follow-on using the second GUC; `ancestors` is explicitly out of scope until a consumer needs it.

Expansion query (run once at session setup, under the user's tenant GUC, reading direct org-unit UUIDs from the token — the UUIDs `normalizeGroups` already extracts, `session.ts:52-54`):

```sql
select distinct descendant_id
from platform.org_unit_closure
where tenant_id = $tenant and ancestor_id = any($directGroupUuids::uuid[])
```

The result array becomes `app.user_groups`; the raw `$directGroupUuids` becomes `app.user_groups_direct`.

### E.2 F5 fix — thread `scope` end to end

1. **`apps/api/src/graphql/context.ts`** — add `scope: DbSessionScope` to `GraphqlSessionContext` (`context.ts:4-14`) and copy it in `createGraphqlContext` (`context.ts:30-35`): `scope: resolved.scope`. Import the `SessionScope`/`DbSessionScope` type. This is the single-line drop-fix.
2. **`apps/api/src/db/session.ts`** — no change needed: `DbSessionInput.scope` already exists (`session.ts:13`), `applyDbSession` already sets `app.scope` (`session.ts:96`), `normalizeScope` already defaults safely (`session.ts:63-66`). Once `context.session.scope` is populated it flows through automatically because resolvers pass `context.session` as `DbSessionInput` (`generated-entity-schema.ts:220` etc.).
3. **Group expansion wiring** (Phase 2): at the resolver/context boundary (before `withDbSession`), replace the raw group pass-through with the expansion from §E.1, setting `groups` (expanded) on the `DbSessionInput`. Add a second GUC set in `applyDbSession` for `app.user_groups_direct` when the exact axis ships.

### E.3 `app-helpers.ts` changes

- **No change** to `app.current_tenant`, `app.current_user_id`, `app.current_groups`, `app.has_scope`, `app.bypass_rls` for Phase 1 (owner + F5). `app.current_groups()` (`app-helpers.ts:28-34`) already returns the GUC array — Phase 2 just fills it with the expanded set.
- **Phase 2 addition:** `app.current_groups_exact()` returning the `app.user_groups_direct` GUC as `uuid[]` (copy of `app.current_groups` reading the direct GUC). Only needed once an entity uses `expand: exact`. Not referenced by the default emitter path (which uses `app.current_groups()`); a future emitter switch on `expand` would select the function — **out of scope for this spec's emitter**, which always emits `app.current_groups()`. Documented open question §Risks.

> `bypassRoles` → `app.has_scope('tenant')`: the emitter branch exists (`generate.ts:141-143`) but `deriveRowScope` omits `bypassRoles` for now (§B.3) because the runtime `scope` resolution already keys off `APP_TENANT_BYPASS_ROLES` env (`identity.ts:61-78`) and setting `app.scope='tenant'` is what actually grants the bypass. Wiring compiled `bypassRoles` per-entity is a separate concern from this finding and is deferred; F5 (setting `app.scope` correctly) is the necessary-and-sufficient runtime fix for the `has_scope` path.

---

## F. Test matrix (required, exhaustive)

Fixtures live **outside** the shipped slice so they never inflate the 3-entity manifest or the coverage gate. Two fixture homes:

- **Compiler unit/determinism tests:** in-memory `PlatformSchemaManifest` objects passed to `generateArtifacts`, exactly like `packages/compiler/src/generate.test.ts:9-36`. No YAML, no allowlist impact.
- **Authoring→rowScope translation tests:** a fixtures dir `packages/compiler/src/authoring/__fixtures__/rowaccess/` holding minimal entity YAMLs (owner entity, group entity), compiled in-memory via `compileAuthoringBackendManifest` with a fixture `authoringDir` + explicit `entityAllowlist` — the allowlist is test-scoped so it never touches the real slice.
- **DB-layer RLS proof:** extend the raw-SQL style of `apps/api/src/db/__tests__/rls-enforcement.test.ts`. Fixture tables are created via a test-only manifest fed through the scratch-DB migration chain, OR by hand-authoring two throwaway tables in the scratch DB with the generated policy SQL. Owner/group org_unit fixtures inserted with raw SQL under the appropriate GUCs.

### F.1 Emitter unit tests (`generate.test.ts`, in-memory manifest)
- **owner empty:public:** manifest table with `rowScope: { userColumns: ["owner_id"], nullVisibleColumns: ["owner_id"] }` → SQL contains `"owner_id" = app.current_user_id() OR "owner_id" IS NULL` inside the tenant-AND group.
- **owner empty:restricted:** `rowScope: { userColumns: ["owner_id"] }` → SQL contains `"owner_id" = app.current_user_id()` and does **NOT** contain `"owner_id" IS NULL`.
- **group descendants:** `rowScope: { group: { column: "org_unit_id", expand: "descendants" } }` → `"org_unit_id" = ANY (app.current_groups())`; index `(tenant_id, org_unit_id)` emitted.
- **owner+group combined:** both branches OR-joined.
- **missing column throws:** `userColumns: ["nope"]` → `renderRowScopePredicate` throws (existing guard `generate.ts:153-159`), assert message.
- **determinism / regression:** the three shipped entities — assert `generateArtifacts` over the real committed manifest yields the exact `{table}_tenant_isolation` blocks currently at `schema.sql:143-173` (snapshot compare of the relations/relation_groups/contact_details policy sections).

### F.2 Translation tests (`backend-manifest`, fixtures)
- **owner entity** (`empty: public`, `owner: { column: owner_id, session: app.current_user_id }`) → produced `TableDefinition.rowScope = { userColumns: ["owner_id"], nullVisibleColumns: ["owner_id"] }`.
- **owner entity `empty: restricted`** → `rowScope.nullVisibleColumns` absent.
- **group entity** → `rowScope.group = { column, expand: "descendants" }`.
- **fail-closed compile errors:**
  - owner column not a persisted uuid / not a belongsTo FK → throws (authoring guard `authorization.ts:176-191`).
  - group column missing at emit time (FK skipped as cross-module-unregistered) → `deriveRowScope` throws (§C.1).
  - `empty: restricted` with no owner and no group → throws (§C.2), assert message.
  - `owner.session !== "app.current_user_id"` → throws (§B.1).
- **no-op determinism:** the 3 shipped entities (`empty: public`, no owner/group) → `rowScope` undefined → table output unchanged (compare against committed manifest.json / schema.sql).

### F.3 F5 runtime tests (`session.ts` / `context.ts`)
- `createGraphqlContext` with a token whose roles include a bypass role (via `APP_TENANT_BYPASS_ROLES`) → `context.session.scope === "tenant"`; with groups only → `"group"`; neither → `"self"`.
- `withDbSession` with `scope: "tenant"` → `select current_setting('app.scope')` returns `tenant` inside the txn, and `app.has_scope('tenant')` returns true. (Raw-SQL assertion inside the transaction.)
- Regression: `scope` absent in input → GUC = `self` (unchanged default).

### F.4 DB-layer RLS proof (`rls-enforcement.test.ts` style — raw queries, NOT app WHERE)
Create fixture tables in the scratch DB with the generated policy. Insert cross-user / cross-group rows under one GUC set, then switch GUCs and run **raw `count(*)` with no app-layer filter** — a 0 proves RLS itself enforced. Mirrors the existing cross-tenant proof (`rls-enforcement.test.ts:120-141`).

- **Owner enforcement (empty:public):**
  - unowned row (`owner_id IS NULL`) visible to any user in tenant.
  - owned row visible only when `app.user_id` = its `owner_id`; raw count as a different user = 0.
- **Owner enforcement (empty:restricted):** unowned row hidden (raw count = 0 for everyone but bypass).
- **Cross-user isolation:** user A's owned row invisible to user B (raw count 0).
- **Group enforcement:**
  - user in group A sees group-A rows (`org_unit_id` ∈ `app.user_groups`).
  - **descendants:** parent-unit user's `app.user_groups` (expanded) includes child unit → sees child's rows; raw count > 0.
  - **exact** (once shipped): parent user does NOT see child's rows (compares to direct set) → raw count 0.
  - **ancestors** (deferred): documented, not tested until shipped.
  - **cross-group isolation:** group-B row invisible to group-A-only user (raw count 0).
- **Bypass:** `app.scope='tenant'` (or `app.bypass_rls()='true'`) sees all rows regardless of owner/group.

Fixtures needed:
- A test entity with a uuid `owner_id` column + policy `... OR ("owner_id" = app.current_user_id() OR "owner_id" IS NULL)`.
- A test entity with a uuid `org_unit_id` column + policy `... OR ("org_unit_id" = ANY(app.current_groups()))`.
- `platform.org_unit` + `platform.org_unit_closure` rows: root unit R, child C (parent R), sibling S; closure rows `(R,R,0),(C,C,0),(R,C,1),(S,S,0)`.
- These fixture tables/rows are created inside the scratch DB in the test only — never in `platform-schema.yaml`'s shipped slice, except `org_unit`/`org_unit_closure` which ARE shipped platform infra (Phase 2) and get their own migration-chain coverage.

---

## G. Phased plan (file ownership for parallel dispatch)

### Phase 1 — Fail-closed guard + owner axis + F5 (self-contained, shippable)
Delivers: owner-predicated RLS emitted from entities, the fail-closed compile guard, and the `app.scope` runtime fix. No group subsystem, no schema.yaml change, no new tables. The 3 shipped entities stay byte-identical.

Sub-parts and **exclusive file ownership** (can parallelize where disjoint):

| Sub-part | Files owned | Depends on |
| --- | --- | --- |
| 1a. Emitter: `nullVisibleColumns` OR-NULL branch | `packages/compiler/src/generate.ts`, `packages/compiler/src/schema.ts` (add `nullVisibleColumns` to `RowScopePolicy`) | — |
| 1b. Compiler types | `packages/compiler/src/authoring/types/common.ts`, `.../types/compiled.ts` | — |
| 1c. `owner.session` constraint + keep authoring column validation | `packages/compiler/src/authoring/compiler/authorization.ts` | 1b |
| 1d. Translation + fail-closed guards (`deriveRowScope`, `empty:restricted` guard) | `packages/compiler/src/authoring/backend-manifest.ts` | 1a, 1b |
| 1e. JSON schema description fixes (owner path only; group added in P2) | `packages/compiler/config/schemas/core-entity.schema.json` | — |
| 1f. F5 runtime: add `scope` to `GraphqlSessionContext` + copy in factory | `apps/api/src/graphql/context.ts` | — |
| 1g. Tests | `packages/compiler/src/generate.test.ts` (emitter+determinism), `packages/compiler/src/authoring/__fixtures__/rowaccess/*` + a `backend-manifest.test.ts`, `apps/api/src/graphql/context.test.ts` (F5), owner-axis additions to `apps/api/src/db/__tests__/rls-enforcement.test.ts` | 1a–1f |

Sequencing inside Phase 1: 1a+1b+1e+1f are disjoint and parallel. 1c depends on 1b. 1d depends on 1a+1b. 1g last.

**Verification gate P1:**
- `bun test packages/compiler` green incl. new emitter/translation/fail-closed tests.
- Regenerate artifacts; `git diff apps/api/src/generated/db/schema.sql apps/api/src/generated/db/manifest.json` shows **zero** change for relations/relation_groups/contact_details (determinism proof).
- `bun test apps/api/src/db/__tests__/rls-enforcement.test.ts` green incl. new owner-axis DB proof.
- `bun test apps/api/src/graphql/context.test.ts` proves `scope` threads to `app.scope`.

### Phase 2 — Group subsystem
Delivers: `authorization.rowAccess.group`, `org_unit` + `org_unit_closure` tables + closure trigger, session-setup group expansion, group-axis DB proof.

**Must be sequential after Phase 1** (depends on the emitter's OR/null plumbing and the F5 scope thread landing first).

| Sub-part | Files owned | Depends on |
| --- | --- | --- |
| 2a. Group vocabulary in schema + types + authoring validation | `core-entity.schema.json` (group def), `common.ts`, `compiled.ts`, `authorization.ts` (group column validation) | P1 |
| 2b. Translation: group axis in `deriveRowScope` | `backend-manifest.ts` (extend the P1 helper) | 2a |
| 2c. Platform tables | `packages/compiler/config/platform-schema.yaml` (org_unit, org_unit_closure) | — (disjoint from 2a/2b) |
| 2d. Closure trigger migration | `apps/api/src/db/migrations/versioned/NNNN_org_unit_closure_trigger.ts` + register in `versioned/index.ts` | 2c |
| 2e. Session-setup group expansion + `app.user_groups_direct` GUC + `app.current_groups_exact()` | `apps/api/src/db/session.ts` (expanded groups + second GUC in `applyDbSession`), `apps/api/src/db/migrations/app-helpers.ts` (new fn), the resolver/context boundary that calls `withDbSession` (`apps/api/src/graphql/generated-entity-schema.ts` / `generated-crud.ts` — inject expansion) | 2c, P1-1f |
| 2f. Tests | group-axis emitter tests (`generate.test.ts`), group translation fixtures (`backend-manifest.test.ts`), org_unit closure trigger test (`apps/api/src/db/__tests__/`), group-axis DB RLS proof (`rls-enforcement.test.ts`) | 2a–2e |

Sequencing inside Phase 2: 2c is disjoint (parallel with 2a/2b). 2d depends on 2c. 2b depends on 2a. 2e depends on 2c + P1. 2f last.

**Verification gate P2:**
- `org_unit`/`org_unit_closure` appear in regenerated `manifest.json` with `{table}_tenant_isolation` policies; closure trigger test proves ancestor/descendant rows maintained on insert/reparent/delete.
- Group-axis DB proof: descendants visibility + cross-group isolation via raw `count(*)` (RLS-enforced, not app WHERE).
- Full `bun test` green across `packages/compiler` and `apps/api`.
- Determinism: the 3 shipped entities still unchanged.

---

## Risks / open questions needing your decision before implementation

1. **`expand` axis coverage.** Spec ships `descendants` (default) fully in P2, `exact` as a thin follow-on (second GUC + `app.current_groups_exact()` + an emitter switch on `expand`). **The default emitter always emits `app.current_groups()`** — wiring the `exact` function into the emitter is *not* in this spec's emitter changes. **Decision needed:** ship P2 with `descendants` only and defer `exact`/`ancestors` entirely, or include the `exact` emitter switch in P2? (Recommendation: descendants-only in P2; add `exact` when a consumer needs it.)

2. **Per-entity `expand` vs per-session GUC.** A session hitting entities with mixed `expand` modes needs multiple expanded sets. The spec stores descendants-expansion in `app.user_groups` and (for exact) direct in `app.user_groups_direct`. **Confirm** this two-GUC model is acceptable, or whether all entities in a deployment are expected to share one `expand` mode (which would simplify to a single GUC).

3. **`bypassRoles` per-entity.** The emitter supports `app.has_scope('tenant')` from `rowScope.bypassRoles`, but this spec wires the tenant bypass purely through runtime `app.scope` (F5 + `APP_TENANT_BYPASS_ROLES` env, `identity.ts:61`). **Decision:** leave per-entity compiled `bypassRoles` unwired (env-driven scope is sufficient for the finding), or thread compiled `bypassRoles` from authoring in a Phase 3? (Recommendation: leave unwired now; the finding is fully closed by owner+group+F5.)

4. **`owner.session` hard constraint.** §B.1 forbids any `owner.session` other than `app.current_user_id`. If any real/planned entity needs a distinct account axis (e.g. per-service-account ownership), option (ii) (arbitrary session var in the emitter) must be reopened. **Confirm** no such entity is planned in this iteration.

5. **org_unit self-FK emission.** `platform.org_unit.parent_id` is a same-schema self-reference. The compiler emits same-schema FKs via `renderColumnForeignKeySql` only when the column carries a `references` block; the manifest loader must accept a self-referential FK without a cycle-ordering deadlock in `sortTablesByDependencies` (`backend-manifest.ts:255-287` handles cycles by flushing, but confirm a single-table self-cycle is tolerated). Low risk, flagged for the P2 implementer to verify with a quick migration-chain test.
