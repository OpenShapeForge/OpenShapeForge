// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import {
  RUNTIME_INBOUND_HASH_ALGORITHMS, RUNTIME_INBOUND_IDENTITY_SOURCES,
  RUNTIME_INBOUND_SIGNATURE_ENCODINGS,
} from "@openshapeforge/plugin-runtime";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { INBOUND_MAX_BODY_BYTES } from "../../platform/inbound-signature.js";
import { databaseRole } from "../database-roles.js";
import { APP_ROLE } from "./app-role.js";
import { WORKER_ROLE } from "./worker-role.js";
import { ensureCheckConstraint } from "./sql-invariants.js";

/**
 * The invariants of the authenticated inbound tables that the manifest cannot
 * express. platform.inbound_endpoints and platform.inbound_deliveries are
 * declared in packages/compiler/config/platform-schema.yaml; this runs after
 * the generated step and adds, idempotently on every migrate, the bounded
 * signature vocabulary, the two state machines, the hash shapes, the
 * endpoints policy and the two reads that happen outside a tenant session.
 *
 * Two things here are load-bearing beyond ordinary shape checking.
 *
 * The algorithm and encoding vocabularies are a DATABASE check, not only a
 * TypeScript one. `createHmac` accepts every digest OpenSSL knows — md5 and
 * sha1 included — so a row reaching the verifier with `signature_algorithm =
 * 'md5'` would be honoured by the crypto library without complaint. The
 * registration path refuses it, the database refuses it again, and the lists
 * are imported from the public contract so the three cannot drift.
 *
 * ## The two point lookups, and why a definer owns them
 *
 * `app.inbound_endpoint_tenant(endpoint_id)` is the read that runs with no
 * tenant: admission has a URL and a body and must find out which tenant, if
 * any, the endpoint belongs to. `app.inbound_endpoint_active(endpoint_id,
 * tenant_id)` is the one bit a queued dispatch re-checks before it leaves.
 * Neither caller may read the registration row itself — the app role is
 * mid-credential-resolution with no tenant GUC to be fenced by, and the worker
 * role is deliberately not granted the table at all, because that row holds
 * the sealed provider secret.
 *
 * So both are SECURITY DEFINER point lookups over a definer role whose whole
 * reach is `select (id, tenant_id, status)` on this one table, admitted by a
 * read policy written TO that role — the pattern of the registry lookups in
 * migrations/identity-link.ts, which this reuses rather than restates. The
 * secret, the signature scheme and the dispatch target are unreachable THROUGH
 * the definer and not merely unselected by it: a column-level grant is what
 * makes `select *` from inside such a body fail.
 *
 * No statement-local `app.bypass_rls` is raised, for the reason identity-link
 * states: a temporary bypass observed by a STABLE helper can be reused for the
 * rest of a caller's statement. Nothing else about the registration leaves
 * either function — not the secret, not the dispatch target, and for the
 * tenant lookup not even whether the row is revoked, which is answered inside
 * the tenant session where it can be an ordinary refusal.
 *
 * The definer role is the manifest's `identityResolver`: the non-login role
 * that already owns the lookups resolving a tenant BEFORE a tenant session
 * exists (`app.tenant_for_keycloak_organization`, `app.tenant_for_scoped_service`).
 * Its generated `purpose` string still names the identity registry alone;
 * docs/migrations.md carries the current inventory, because changing that
 * string is a role-contract change and re-provisioning.
 */
const REGISTRY_RESOLVER_ROLE = databaseRole("identityResolver").name;

export async function applyInboundMigration(db: OpenShapeForgeDatabase): Promise<void> {
  const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

  const endpoints = "platform.inbound_endpoints";
  await ensureCheckConstraint(db, {
    table: endpoints,
    name: "inbound_endpoints_endpoint_key_check",
    expression: "endpoint_key ~ '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*$' and length(endpoint_key) <= 64",
  });
  await ensureCheckConstraint(db, {
    table: endpoints,
    name: "inbound_endpoints_signature_header_check",
    expression: "signature_header ~ '^[a-z0-9][a-z0-9-]{0,62}$'",
  });
  // The bounded algorithm set, enforced where a row cannot talk its way past it.
  await ensureCheckConstraint(db, {
    table: endpoints,
    name: "inbound_endpoints_signature_algorithm_check",
    expression: `signature_algorithm in (${quoted(RUNTIME_INBOUND_HASH_ALGORITHMS)})`,
  });
  await ensureCheckConstraint(db, {
    table: endpoints,
    name: "inbound_endpoints_signature_encoding_check",
    expression: `signature_encoding in (${quoted(RUNTIME_INBOUND_SIGNATURE_ENCODINGS)})`,
  });
  await ensureCheckConstraint(db, {
    table: endpoints,
    name: "inbound_endpoints_metadata_header_check",
    expression:
      "(unsigned_delivery_id_header is null or unsigned_delivery_id_header ~ '^[a-z0-9][a-z0-9-]{0,62}$')" +
      " and (unsigned_event_type_header is null or unsigned_event_type_header ~ '^[a-z0-9][a-z0-9-]{0,62}$')",
  });
  // The identity vocabulary, enforced where a row cannot talk its way past it,
  // for the same reason the algorithm list is: a row naming a source the host
  // does not implement must not reach admission at all.
  await ensureCheckConstraint(db, {
    table: endpoints,
    name: "inbound_endpoints_identity_source_check",
    expression: `identity_source in (${quoted(RUNTIME_INBOUND_IDENTITY_SOURCES)})`,
  });
  // `body-field` has paths and `body-digest` has none — stored the other way
  // round, a profile would claim an identity the delivery key does not use.
  //
  // `identity_fields is not null` is stated rather than left to the regex. A
  // CHECK admits a row whose expression is UNKNOWN, and `null ~ '…'` is
  // UNKNOWN, not false: without that conjunct `identity_source = 'body-field'`
  // with no paths at all passed the constraint — the exact row the TypeScript
  // side refuses, admitted by the database that is meant to refuse it again.
  // Every operand below is now NOT NULL (`identity_source` is a required
  // column) or explicitly null-tested, so the expression is two-valued.
  //
  // One dotted path, up to six segments, as modules/inbound-identity.ts spells
  // it. SHAPE only: `__proto__` is a well-formed path here and is refused where
  // it matters, by `storedInboundIdentity`, which answers no usable profile and
  // so makes admission refuse the row.
  const path = "[A-Za-z_][A-Za-z0-9_-]{0,63}(\\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,5}";
  await ensureCheckConstraint(db, {
    table: endpoints,
    name: "inbound_endpoints_identity_shape",
    expression:
      `((identity_source = 'body-digest' and identity_fields is null)` +
      ` or (identity_source = 'body-field' and identity_fields is not null` +
      ` and identity_fields ~ '^${path}(,${path}){0,3}$'))` +
      ` and (identity_event_type_path is null or identity_event_type_path ~ '^${path}$')`,
  });
  // The host ceiling, as the database sees it: a registration may lower the
  // bound on its own bodies and can never raise it above what the verifier
  // will hash.
  await ensureCheckConstraint(db, {
    table: endpoints,
    name: "inbound_endpoints_max_body_bytes_check",
    expression: `max_body_bytes > 0 and max_body_bytes <= ${INBOUND_MAX_BODY_BYTES}`,
  });
  await ensureCheckConstraint(db, {
    table: endpoints,
    name: "inbound_endpoints_dispatch_check",
    expression: "length(operation_id) > 0 and operation_input_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'" +
      " and length(service_identity_id) > 0",
  });
  await ensureCheckConstraint(db, {
    table: endpoints,
    name: "inbound_endpoints_status_shape",
    expression:
      "(status = 'active' and revoked_at is null and revoked_reason is null)" +
      " or (status = 'revoked' and revoked_at is not null)",
  });

  const deliveries = "platform.inbound_deliveries";
  await ensureCheckConstraint(db, {
    table: deliveries,
    name: "inbound_deliveries_body_sha256_check",
    expression: "body_sha256 ~ '^[0-9a-f]{64}$'",
  });
  await ensureCheckConstraint(db, {
    table: deliveries,
    name: "inbound_deliveries_contract_fingerprint_check",
    expression: "contract_fingerprint is null or contract_fingerprint ~ '^sha256:[0-9a-f]{64}$'",
  });
  // The payload's two states, and nothing between them: sealed and whole, or
  // removed and recorded as removed. A half-purged row — a ciphertext with no
  // key id, or a purge timestamp beside a payload still there — would make the
  // worker's "is this readable" question unanswerable.
  await ensureCheckConstraint(db, {
    table: deliveries,
    name: "inbound_deliveries_body_shape",
    expression:
      "(body_purged_at is null and body_ciphertext is not null" +
      " and body_key_id is not null and body_algorithm is not null)" +
      " or (body_purged_at is not null and body_ciphertext is null" +
      " and body_key_id is null and body_algorithm is null)",
  });
  await ensureCheckConstraint(db, {
    table: deliveries,
    name: "inbound_deliveries_body_bytes_check",
    expression: `body_bytes >= 0 and body_bytes <= ${INBOUND_MAX_BODY_BYTES}`,
  });
  await ensureCheckConstraint(db, {
    table: deliveries,
    name: "inbound_deliveries_idempotency_key_check",
    // The key travels in an HTTP header on the way to the Operation, so the
    // shape the broker needs is the shape the row is allowed to have.
    expression: "idempotency_key ~ '^inbound\\.[0-9a-f-]{36}\\.[0-9a-f]{64}$'",
  });
  await ensureCheckConstraint(db, {
    table: deliveries,
    name: "inbound_deliveries_status_check",
    expression: "status in ('pending', 'dispatching', 'delivered', 'failed', 'outcome_unknown')",
  });
  await ensureCheckConstraint(db, {
    table: deliveries,
    name: "inbound_deliveries_dispatch_state_check",
    expression: "dispatch_state in ('none', 'started', 'not-dispatched')",
  });
  // A dispatch state names the attempt it belongs to, or there is no state.
  // Without this pairing a reclaim could read "started" and not know whose.
  await ensureCheckConstraint(db, {
    table: deliveries,
    name: "inbound_deliveries_dispatch_shape",
    expression:
      "(dispatch_state = 'none' and dispatch_attempt is null)" +
      " or (dispatch_state <> 'none' and dispatch_attempt is not null and dispatch_attempt >= 1)",
  });
  await ensureCheckConstraint(db, {
    table: deliveries,
    name: "inbound_deliveries_status_shape",
    expression:
      "(status in ('pending', 'dispatching') and completed_at is null)" +
      " or (status in ('delivered', 'failed', 'outcome_unknown') and completed_at is not null)",
  });

  await sql`
    alter table platform.inbound_endpoints enable row level security;
    alter table platform.inbound_endpoints force row level security;

    drop policy if exists inbound_endpoints_tenant_isolation on platform.inbound_endpoints;
    create policy inbound_endpoints_tenant_isolation on platform.inbound_endpoints
      using (app.bypass_rls() or tenant_id = app.current_tenant())
      with check (app.bypass_rls() or tenant_id = app.current_tenant());

    -- The definer's whole reach over this table: three columns, read-only, and
    -- a policy that admits rows for SELECT only and only to this role. The
    -- sealed secret columns are outside the grant, so a body that asked for
    -- them would be refused rather than trusted to be narrow.
    grant usage on schema app, platform to ${sql.id(REGISTRY_RESOLVER_ROLE)};
    grant select (id, tenant_id, status)
      on platform.inbound_endpoints to ${sql.id(REGISTRY_RESOLVER_ROLE)};
    drop policy if exists inbound_endpoints_registry_resolution on platform.inbound_endpoints;
    create policy inbound_endpoints_registry_resolution on platform.inbound_endpoints for select
      to ${sql.id(REGISTRY_RESOLVER_ROLE)} using (true);

    -- The pre-authentication point lookup. ONE tenant id for ONE endpoint id,
    -- never a list. A revoked endpoint still answers its tenant — the
    -- revocation is checked inside the tenant session, where it can be
    -- answered as an ordinary refusal rather than as a distinguishable one
    -- here.
    create or replace function app.inbound_endpoint_tenant(endpoint uuid) returns uuid
    language sql stable security definer
    set search_path = pg_catalog, pg_temp
    as $fn$
      select e.tenant_id
        from platform.inbound_endpoints e
       where e.id = $1
       limit 1
    $fn$;

    -- The LIVE registration check a dispatch is fenced by.
    --
    -- The worker resolves durable work across tenants for
    -- platform.inbound_deliveries and for no other table, so it cannot read
    -- platform.inbound_endpoints — and it must not: that row holds the sealed
    -- provider secret and the registration's whole configuration. This answers
    -- the one bit a dispatch needs, for one (endpoint, tenant) PAIR, so a
    -- delivery can never be cleared by an active endpoint of another tenant.
    -- An unknown endpoint, a revoked one and another tenant's are one answer:
    -- false.
    --
    -- STABLE, so the answer is the one the CALLER's statement snapshot sees:
    -- the re-check belongs to the resolve, the pin and the dispatch mark it is
    -- embedded in, and must not be a value cached from an earlier statement.
    create or replace function app.inbound_endpoint_active(endpoint uuid, tenant uuid)
    returns boolean
    language sql stable security definer
    set search_path = pg_catalog, pg_temp
    as $fn$
      select exists (
        select 1
          from platform.inbound_endpoints e
         where e.id = $1 and e.tenant_id = $2 and e.status = 'active'
      )
    $fn$;

    -- Postgres requires the incoming owner to hold CREATE on the schema at the
    -- moment of the transfer (a superuser migrator skips that check; the
    -- restricted one does not). Granted for the transfer only.
    grant create on schema app to ${sql.id(REGISTRY_RESOLVER_ROLE)};
    alter function app.inbound_endpoint_tenant(uuid) owner to ${sql.id(REGISTRY_RESOLVER_ROLE)};
    alter function app.inbound_endpoint_active(uuid, uuid) owner to ${sql.id(REGISTRY_RESOLVER_ROLE)};
    revoke create on schema app from ${sql.id(REGISTRY_RESOLVER_ROLE)};
    -- CREATE FUNCTION defaults to EXECUTE for PUBLIC, so a first install
    -- would otherwise expose both lookups to every role in the window before
    -- the grant sweeps.
    revoke all on function app.inbound_endpoint_tenant(uuid) from public;
    revoke all on function app.inbound_endpoint_active(uuid, uuid) from public;
    grant execute on function app.inbound_endpoint_tenant(uuid) to ${sql.id(APP_ROLE)};
    grant execute on function app.inbound_endpoint_active(uuid, uuid) to ${sql.id(APP_ROLE)};
  `.execute(db);
}

/**
 * The inbound EXECUTE grants, re-applied after the role sweeps.
 *
 * `applyWorkerRoleGrants` grants EXECUTE on every function in schema `app` to
 * the worker role and sets a default privilege that would catch a later one
 * too. The worker needs exactly one of these two lookups — the tenant-paired
 * liveness boolean — so the other is revoked here, after that sweep, the way
 * the record-action lookup is. Same reason the revoke from PUBLIC is restated:
 * a sweep that grants "all functions" must not quietly widen either lookup.
 *
 * Nothing here gives the worker the endpoints table or any column of it.
 */
export async function applyInboundGrants(db: OpenShapeForgeDatabase): Promise<void> {
  await sql`
    revoke all on function app.inbound_endpoint_tenant(uuid) from public;
    revoke all on function app.inbound_endpoint_active(uuid, uuid) from public;
    -- Which tenant owns an endpoint id is admission's question, not a
    -- worker's: the worker already reads the pairing off the delivery rows it
    -- resolves, and a dispatch is fenced by the liveness bit alone.
    revoke all on function app.inbound_endpoint_tenant(uuid) from ${sql.id(WORKER_ROLE)};
    grant execute on function app.inbound_endpoint_tenant(uuid) to ${sql.id(APP_ROLE)};
    grant execute on function app.inbound_endpoint_active(uuid, uuid) to ${sql.id(APP_ROLE)};
    grant execute on function app.inbound_endpoint_active(uuid, uuid) to ${sql.id(WORKER_ROLE)};
  `.execute(db);
}
