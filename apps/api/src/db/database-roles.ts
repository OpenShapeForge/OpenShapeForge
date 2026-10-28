// SPDX-License-Identifier: BUSL-1.1
/**
 * The database role contract: declared by the compiler, provisioned by the
 * host, verified by the migration chain.
 *
 * Postgres roles are CLUSTER-wide. A migration is per database and runs as
 * the migrate role, which on a managed instance deliberately has neither
 * SUPERUSER nor CREATEROLE. So the chain never creates roles; it checks that
 * every role the generated schema depends on exists with the load-bearing
 * attributes, and that the migrate role is a member of the definer roles
 * whose objects it must hand over. Anything missing is reported with the
 * exact statements an administrator runs — the same statements
 * {@link provisionDatabaseRoles} executes when given the admin connection.
 *
 * TWO OPENSHAPEFORGE DATABASES IN ONE CLUSTER
 * -------------------------------------------
 * {@link readRoleMembers} is where a cluster-wide object meets a per-database
 * check. The member list is cluster-wide; both yardsticks a member is held
 * against are per database — the migrate identity the check is connected as,
 * and `datdba`. The same member list must therefore be accounted for in BOTH
 * databases, which is a condition on the MIGRATE IDENTITIES and the
 * memberships they hold, and not on the owners being equal or distinct:
 *
 *   - ONE migrate identity for both databases satisfies the contract however
 *     their owners differ. It is the only member, and each database
 *     recognises it as the identity it is connected as;
 *   - TWO migrate identities satisfy it only where each database can account
 *     for the other's on one of the three grounds this check accepts: the
 *     member is SUPERUSER, a role the connected migrate identity itself
 *     inherits, or a holder of that database's owner privileges. Where each
 *     database is owned by the role that migrates it, none of the three covers
 *     the other's migrator, so both refuse, each naming it against all three
 *     definer roles. That refusal is symmetric: no provisioning order
 *     satisfies both, the `revoke` each error names would break the other
 *     database, and two roles cannot be members of each other.
 *
 * Two databases sharing one owner therefore pass where each is migrated as an
 * identity holding that owner's privileges — the usual deployment shape, where
 * the migrate role owns the database it migrates — and are refused where
 * neither identity is covered on any of those grounds, exactly as two distinct
 * owners are. Sharing an owner is not sufficient on its own and distinct
 * owners are not what fails: what counts is what each member of the definer
 * roles is in the database doing the checking.
 *
 * Verified in __tests__/database-role-contract.test.ts, on PostgreSQL 17.11
 * and 16.15: it provisions a second database in the test cluster and runs
 * {@link verifyDatabaseRoles} in both databases. Two databases each owned by
 * the distinct non-superuser role that migrates it refuse symmetrically; the
 * same two databases with distinct owners under ONE migrate identity pass in
 * both; and a second migrate identity granted the second database's owner is
 * accepted there while the first database, whose owner privileges it does not
 * hold, still refuses it.
 *
 * The check cannot admit a member on the strength of its being SOME database's
 * owner: that would let the owner of any database in the cluster hold the
 * definer roles' grants in this one. One cluster per deployment, which is what
 * `db:provision-roles` assumes, needs none of this. See docs/migrations.md.
 */
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "./connection.js";
import manifest from "../generated/db/manifest.json" with { type: "json" };

export type DatabaseRoleContract = {
  key: "app" | "worker" | "blueprintReader" | "identityResolver" | "recordActionResolver";
  name: string;
  login: boolean;
  migratorMember: boolean;
  purpose: string;
};

export const DATABASE_ROLES: readonly DatabaseRoleContract[] =
  (manifest as { databaseRoles?: readonly DatabaseRoleContract[] }).databaseRoles ?? [];

export function databaseRole(key: DatabaseRoleContract["key"]): DatabaseRoleContract {
  const role = DATABASE_ROLES.find((candidate) => candidate.key === key);
  if (!role) throw new Error(`The generated manifest declares no ${key} database role.`);
  return role;
}

type RoleRow = {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolinherit: boolean;
  /** The migrate identity holds this role's privileges and can SET ROLE to it, by ANY path. */
  member: boolean;
  /** `grant <role> to <migrate identity>` exists — not a path through a third role. */
  direct: boolean;
  /** That direct grant carries INHERIT and SET, so it alone is what the identity holds. */
  directGrant: boolean;
};

/**
 * The identity a migration actually runs as, and the ONE other role name the
 * membership contract admits.
 *
 * Every rule below compares role NAMES against these two. `pg_has_role` is not
 * an identity test: `pg_has_role(current_user, X, 'USAGE')` is true for every
 * role X granted TO the migrate role, and true for EVERY role when the caller
 * is a superuser. Using it to answer "is this member the migrator?" admitted
 * both — a helper role granted to migrate and also granted a definer role
 * passed the contract, and a superuser caller passed every member of every
 * definer role (verified on PostgreSQL 17.11). That helper inherits the
 * definer role's grants and, because object ownership is resolved with
 * `has_privs_of_role`, OWNS its SECURITY DEFINER functions: with `CREATE` on
 * schema `app` it can `create or replace app.record_action_allows`.
 */
export type MigrateIdentity = {
  /** `current_user`, by name. */
  user: string;
  /**
   * The caller is a SUPERUSER. It needs no grant to hand objects over and is
   * outside row security and privilege checks either way, so it satisfies the
   * membership requirement explicitly rather than by accident of `pg_has_role`
   * — and it never widens which MEMBERS of a definer role are admitted.
   */
  superuser: boolean;
  /**
   * The owner of the current database, by name. It already owns the schema the
   * definer objects live in, so its membership is part of the contract; a role
   * that merely holds its privileges is not it, and is reported.
   */
  databaseOwner: string | null;
};

/**
 * A role that can act as a definer role and that the contract does not admit.
 *
 * "Can act as" is reachability in the membership graph, not a direct grant:
 * see {@link readUnintendedDefinerMembers}.
 */
export type UnintendedDefinerMember = {
  /** The definer role that is reached. */
  role: string;
  /** The role that reaches it. */
  member: string;
  /**
   * The role `member` holds DIRECTLY on this route — `role` itself at depth 1.
   * One row per distinct `via`, because `revoke <via> from <member>` cuts that
   * route and no other: see {@link readUnintendedDefinerMembers}.
   */
  via: string;
  /** The shortest chain from the unintended member to the definer role through `via`. */
  path: string;
  /** `member` owns a database on this cluster other than the current one. */
  ownsOtherDatabase: boolean;
};

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Invalid database role name: ${name}`);
  return name;
}

/** The statements an administrator runs to satisfy the contract. Passwords are
 * never rendered; login roles get a placeholder the operator replaces. */
export function renderProvisioningSql(options: { migratorRole?: string } = {}): string {
  const lines: string[] = [];
  for (const role of DATABASE_ROLES) {
    const name = identifier(role.name);
    const attributes = role.login
      ? "login password '<set-by-operator>' nosuperuser nobypassrls nocreatedb " +
        "nocreaterole noreplication"
      : "nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication";
    lines.push(`-- ${role.purpose}`);
    lines.push(
      `do $$ begin if not exists (select 1 from pg_roles where rolname = '${name}') ` +
        `then create role ${name} ${attributes}; end if; end $$;`,
    );
    if (role.migratorMember && options.migratorRole) {
      lines.push(`grant ${name} to ${identifier(options.migratorRole)} with inherit true, set true;`);
    }
  }
  return lines.join("\n");
}

/** The migrate identity, read once and compared by name from then on. */
export async function readMigrateIdentity(db: OpenShapeForgeDatabase): Promise<MigrateIdentity> {
  const result = await sql<MigrateIdentity>`
    select current_user as "user",
      coalesce((select rolsuper from pg_roles where rolname = current_user), false) as superuser,
      (select owner.rolname from pg_database d
         join pg_roles owner on owner.oid = d.datdba
        where d.datname = current_database()) as "databaseOwner"
  `.execute(db);
  return result.rows[0]!;
}

/**
 * How deep the membership graph is walked. Postgres forbids cycles, so the walk
 * terminates on its own; this bounds the work it may do on a dense grant
 * lattice an administrator built.
 *
 * A chain longer than this is not a way past the contract. Every role on it at
 * depth 1..16 is reported unless it is admitted, and the nearest reported role
 * fails the check and carries the `revoke` that cuts the whole chain — so a
 * 17-hop chain only hides behind 16 ADMITTED hops, which means 16 superusers
 * (the migrate identity and the database owner are one role each). A role that
 * can become a superuser already holds everything the definer roles do and
 * more, with or without this walk.
 */
const MEMBERSHIP_DEPTH = 16;

/**
 * Every role that can ACT AS one of the given definer roles and that the
 * contract does not admit, by NAME.
 *
 * REACHABILITY, NOT A DIRECT GRANT
 * --------------------------------
 * A direct scan of `pg_auth_members` answers the wrong question. The two
 * admitted members are themselves ordinary roles, and a role granted one of
 * THEM reaches the definer role through it: with `grant <definer> to <owner>`
 * and `grant <owner> to <third>`, that third role runs `set role <owner>;
 * set role <definer>; create or replace app.record_action_allows(...)` and
 * decides every record action — without ever appearing as a member of the
 * definer role (verified on PostgreSQL 17.11 and 16.15). So the walk starts
 * at each definer role and follows `pg_auth_members` outwards transitively,
 * through the admitted roles as well.
 *
 * EVERY EDGE COUNTS
 * -----------------
 * A membership can carry INHERIT, SET and ADMIN independently, and none of
 * the three is safe here: INHERIT hands over the definer role's privileges
 * and, because ownership is resolved with `has_privs_of_role`, the ownership
 * of its SECURITY DEFINER functions; SET lets the member become it; and ADMIN
 * alone is enough, because the member may `grant <role> to <itself> with
 * inherit true, set true` (verified on PostgreSQL 17.11). An edge with all
 * three false confers nothing today, but it has no purpose on the path to a
 * definer role either, so the walk does not carve it out: it is reported with
 * the same `revoke` rather than classified as harmless.
 *
 * ADMITTED, AND NOTHING ELSE
 * --------------------------
 *   - `current_user`, the migrate identity that must hand the objects over.
 *     The grant has to be to that identity itself: a role granted TO it is a
 *     different principal that reaches everything the migrate identity does;
 *   - the owner of the current database, which already owns the schema those
 *     objects live in. By name again — a role that merely holds the owner's
 *     privileges would, as a definer member, gain function ownership the
 *     owner's privileges alone do not confer;
 *   - a SUPERUSER, because it is outside row security and every privilege
 *     check with or without the membership, so revoking it would change
 *     nothing. The walk still passes THROUGH a superuser: a role that can
 *     become one reaches the definer role, and holds far more besides.
 *
 * EVERY ROUTE, NOT THE NEAREST ONE
 * --------------------------------
 * A role can reach a definer role by SEVERAL routes, and `revoke <via> from
 * <member>` cuts exactly one of them — the first hop of the route it is read
 * off. After `grant <definer> to <owner>`, `grant <definer> to <migrate>`,
 * `grant <owner> to <attacker>` and `grant <migrate> to <attacker>`, the
 * attacker reaches the definer role twice over; reporting only the shortest
 * route printed one revoke, and an operator who ran it was still exposed
 * through the other. So the result carries one row per distinct
 * `(definer role, member, via)` — per FIRST HOP out of the member towards the
 * definer role — and revoking all of them removes every edge by which that
 * member reaches it. The chain shown per row is the shortest one through that
 * hop, because the hop is what the remedy acts on.
 *
 * That also bounds the result: at most one row per definer role per
 * `pg_auth_members` edge, however many distinct paths run through it.
 *
 * Admitted roles are not reported; everything else on a path is, with a chain
 * it travels and the `revoke` that cuts that route.
 *
 * Nothing here depends on what the CALLER holds, so a superuser running the
 * check sees the same deviations a restricted migrate role does.
 */
export async function readUnintendedDefinerMembers(
  db: OpenShapeForgeDatabase,
  roles: readonly string[],
): Promise<UnintendedDefinerMember[]> {
  const names = roles.map((role) => sql.lit(identifier(role)));
  if (names.length === 0) return [];
  const result = await sql<UnintendedDefinerMember>`
    with recursive reachable as (
      select definer.rolname as role, am.member as member_oid,
        definer.rolname as via, definer.rolname || ' <- ' || member.rolname as path, 1 as depth
      from pg_auth_members am
      join pg_roles definer on definer.oid = am.roleid
      join pg_roles member on member.oid = am.member
      where definer.rolname in (${sql.join(names)})
      union all
      select r.role, am.member, holder.rolname, r.path || ' <- ' || member.rolname, r.depth + 1
      from reachable r
      join pg_roles holder on holder.oid = r.member_oid
      join pg_auth_members am on am.roleid = r.member_oid
      join pg_roles member on member.oid = am.member
      where r.depth < ${MEMBERSHIP_DEPTH}
    )
    select distinct on (r.role, member.rolname, r.via)
      r.role, member.rolname as member, r.via, r.path,
      exists (select 1 from pg_database d
        where d.datdba = member.oid and d.datname <> current_database()) as "ownsOtherDatabase"
    from reachable r
    join pg_roles member on member.oid = r.member_oid
    where not member.rolsuper
      and member.rolname <> current_user
      and member.oid <> coalesce(
        (select datdba from pg_database where datname = current_database()), 0)
    order by r.role, member.rolname, r.via, r.depth
  `.execute(db);
  return result.rows;
}

/**
 * Why a reachable role was refused, in one sentence an operator can act on.
 *
 * Roles are cluster-wide; the definer roles are named once in the manifest and
 * shared by every OpenShapeForge database on the cluster, while "this
 * database's owner" is per database. So a second OpenShapeForge database with
 * a DIFFERENT owner makes each database refuse the other's owner, and that is
 * the supported policy rather than an oversight: admitting any database owner
 * would admit whoever a `CREATEDB` role made one. The sentence says so when it
 * applies, so the refusal is not mistaken for a broken grant.
 */
export function explainDefinerMember(
  row: UnintendedDefinerMember,
  identity: MigrateIdentity,
): string {
  const owner = identity.databaseOwner ?? "(unknown)";
  const reach =
    row.via === row.role
      ? `role ${row.member} is a member of definer role ${row.role}`
      : `role ${row.member} can act as definer role ${row.role} through ${row.path}`;
  const cluster = row.ownsOtherDatabase
    ? `. ${row.member} owns another database on this cluster: definer roles are cluster-wide, ` +
      "so every OpenShapeForge database sharing a cluster must share one owner and one migrate " +
      "identity, or be given its own cluster"
    : "";
  return (
    `${reach}, and is neither the migrate role ${identity.user} nor this database's owner ` +
    `${owner}${cluster}`
  );
}

async function readRoles(db: OpenShapeForgeDatabase): Promise<Map<string, RoleRow>> {
  const names = DATABASE_ROLES.map((role) => sql.lit(identifier(role.name)));
  if (names.length === 0) return new Map();
  const result = await sql<RoleRow>`
    select r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole,
      r.rolcreatedb, r.rolreplication, r.rolinherit,
      (pg_has_role(current_user, r.rolname, 'USAGE')
        and pg_has_role(current_user, r.rolname, 'SET')) as member,
      exists (select 1 from pg_auth_members am
        where am.roleid = r.oid
          and am.member = (select cu.oid from pg_roles cu where cu.rolname = current_user)) as direct,
      -- The options ON A DIRECT EDGE. inherit_option and set_option exist
      -- from PostgreSQL 16, which the database suite runs on in CI and which
      -- is therefore the oldest server this contract supports; on an older
      -- one this query errors rather than passing. pg_has_role answers for the whole
      -- graph, so an optionless direct grant passes it whenever a third role
      -- supplies the privilege — exactly the shape the member scan is meant
      -- to surface (verified on PostgreSQL 17.11 and 16.15). One (role,
      -- member) pair can have SEVERAL grants from different grantors, as a
      -- createrole_self_grant edge beside the host's grant does, and holding
      -- one that carries both options is what the contract asks for.
      exists (select 1 from pg_auth_members am
        where am.roleid = r.oid
          and am.member = (select cu.oid from pg_roles cu where cu.rolname = current_user)
          and am.inherit_option and am.set_option) as "directGrant"
    from pg_roles r
    where r.rolname in (${sql.join(names)})
  `.execute(db);
  return new Map(result.rows.map((row) => [row.rolname, row]));
}

/** Every role a declared role is itself a member of, and therefore inherits. */
async function readRoleMemberships(db: OpenShapeForgeDatabase): Promise<Map<string, string[]>> {
  const names = DATABASE_ROLES.map((role) => sql.lit(identifier(role.name)));
  if (names.length === 0) return new Map();
  const result = await sql<{ role: string; parent: string }>`
    select member.rolname as role, role.rolname as parent
    from pg_auth_members am
    join pg_roles role on role.oid = am.roleid
    join pg_roles member on member.oid = am.member
    where member.rolname in (${sql.join(names)})
    order by member.rolname, role.rolname
  `.execute(db);
  const memberships = new Map<string, string[]>();
  for (const row of result.rows) {
    memberships.set(row.role, [...(memberships.get(row.role) ?? []), row.parent]);
  }
  return memberships;
}

/**
 * Check the contract against pg_roles as the CURRENT connection. Throws one
 * error naming every deviation and the statements that fix them, so a fresh
 * environment fails once with the complete remedy rather than one role at a
 * time.
 *
 * Attributes, MEMBERSHIP IN the declared roles, and the declared roles' own
 * memberships are all part of the contract:
 *
 *   - no declared role may be SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or
 *     REPLICATION. The first two put it outside row security; the rest let it
 *     widen its own reach without an administrator;
 *   - a definer role must be NOINHERIT and a member of nothing. Its functions
 *     are SECURITY DEFINER, so `grant <anything> to <definer>` would widen
 *     every one of those bodies at once;
 *   - the migrate identity holds every role it must hand objects over to by a
 *     DIRECT grant carrying INHERIT and SET, or is a superuser and needs none.
 *     A membership that only exists through a third role means that role can
 *     act as the definer role too, and the rule below is what refuses it;
 *   - the only roles that can ACT AS a definer role are the migrate identity
 *     itself and the owner of this database, by
 *     {@link readUnintendedDefinerMembers} — which walks the membership graph
 *     transitively, so a role granted one of those two is refused as well, and
 *     reports one `revoke` per route rather than one per role, because a route
 *     left standing is the whole problem again.
 *     Every other holder inherits the definer role's narrow grants, OWNS its
 *     SECURITY DEFINER functions (ownership is resolved with
 *     `has_privs_of_role`) AND is matched by the policies written `TO` it. A
 *     second holder is a second holder of those grants; the record-action
 *     fence bounds its writes (its exemption is the table owner's privileges,
 *     not a role name) but nothing stops it replacing a function body, so the
 *     contract is that it does not exist. Superusers are accepted because they
 *     are outside row security and privilege checks regardless of any
 *     membership.
 *
 * Deviations are reported with the `revoke` that fixes them and never revoked
 * here: this runs as the migrate role, which is deliberately not a role
 * administrator, and a membership an operator created is theirs to remove.
 */
export async function verifyDatabaseRoles(db: OpenShapeForgeDatabase): Promise<void> {
  const rows = await readRoles(db);
  const identity = await readMigrateIdentity(db);
  const current = identity.user;
  const problems: string[] = [];
  const remedies: string[] = [];
  for (const role of DATABASE_ROLES) {
    const row = rows.get(role.name);
    if (!row) {
      problems.push(`role ${role.name} (${role.key}) does not exist`);
      continue;
    }
    if (row.rolsuper) problems.push(`role ${role.name} must not be SUPERUSER`);
    if (row.rolbypassrls) problems.push(`role ${role.name} must not have BYPASSRLS`);
    if (row.rolcreaterole) problems.push(`role ${role.name} must not have CREATEROLE`);
    if (row.rolcreatedb) problems.push(`role ${role.name} must not have CREATEDB`);
    if (row.rolreplication) problems.push(`role ${role.name} must not have REPLICATION`);
    if (row.rolcanlogin !== role.login) {
      problems.push(`role ${role.name} must ${role.login ? "" : "not "}be able to log in`);
    }
    // A definer role owns SECURITY DEFINER functions, so what it inherits is
    // what those bodies run with.
    if (!role.login && row.rolinherit) {
      problems.push(`definer role ${role.name} must be NOINHERIT`);
      remedies.push(`alter role ${identifier(role.name)} noinherit;`);
    }
    // A superuser hands the objects over without a grant. Otherwise the grant
    // must name the migrate identity itself AND carry INHERIT and SET on that
    // edge: holding the role through a third role makes that role a member,
    // which the member scan below refuses, and `pg_has_role` cannot tell the
    // two apart because it answers for the whole graph.
    if (role.migratorMember && !identity.superuser && !row.directGrant) {
      problems.push(
        !row.direct && !row.member
          ? `migrate role ${current} is not a member of ${role.name}`
          : !row.direct
            ? `migrate role ${current} holds ${role.name} only through another role, ` +
              `not as a direct member`
            : `migrate role ${current} is a member of ${role.name} without INHERIT and SET`,
      );
      remedies.push(
        `grant ${identifier(role.name)} to ${identifier(current)} with inherit true, set true;`,
      );
    }
  }
  const definers = new Set(DATABASE_ROLES.filter((role) => !role.login).map((role) => role.name));
  for (const [name, parents] of await readRoleMemberships(db)) {
    if (!definers.has(name)) continue;
    for (const parent of parents) {
      problems.push(`definer role ${name} must not be a member of ${parent}`);
      remedies.push(`revoke ${identifier(parent)} from ${identifier(name)};`);
    }
  }
  for (const row of await readUnintendedDefinerMembers(db, [...definers])) {
    problems.push(explainDefinerMember(row, identity));
    remedies.push(`revoke ${identifier(row.via)} from ${identifier(row.member)};`);
  }
  if (problems.length === 0) return;
  // The provisioning script already carries the grant for every role the
  // migrate identity must hold, so a missing or optionless grant is not
  // repeated after it, and two roles missing the same revoke say it once.
  const provisioning = renderProvisioningSql({ migratorRole: current });
  const already = new Set(provisioning.split("\n"));
  const extra = [...new Set(remedies)].filter((statement) => !already.has(statement));
  throw new Error(
    "Database role contract is not satisfied:\n" +
      problems.map((problem) => `  - ${problem}`).join("\n") +
      "\n\nRoles are cluster-wide and are provisioned by the host, not by this migration. " +
      "Run apps/api/src/db/provision-roles.ts with OPENSHAPEFORGE_ADMIN_DATABASE_URL, " +
      "or execute ALL of the following as an administrator — each revoke cuts one route " +
      "into one definer role, and a role listed more than once reaches it more than once:" +
      "\n\n" +
      [provisioning, ...extra].join("\n"),
  );
}

export type ProvisionOptions = {
  /** Password per login role, keyed by contract key. Required for login roles that do not exist yet. */
  passwords: Partial<Record<DatabaseRoleContract["key"], string>>;
  /** Existing login roles whose passwords must be rotated explicitly. */
  rotatePasswords?: Partial<Record<DatabaseRoleContract["key"], boolean>>;
  /** The migrate role that must become a member of the definer roles. */
  migratorRole?: string;
};

export type ProvisionResult = { created: string[]; rotated: string[]; granted: string[]; unchanged: string[] };

/**
 * Satisfy the contract as an ADMINISTRATOR connection (CREATEROLE). Idempotent:
 * existing roles are left untouched unless their password is explicitly
 * selected for rotation, and memberships are granted only when missing.
 */
export async function provisionDatabaseRoles(
  admin: OpenShapeForgeDatabase,
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const result: ProvisionResult = { created: [], rotated: [], granted: [], unchanged: [] };
  const before = await readRoles(admin);
  for (const role of DATABASE_ROLES) {
    const name = identifier(role.name);
    if (!before.has(role.name)) {
      if (role.login) {
        const password = options.passwords[role.key];
        if (!password) {
          throw new Error(`A password is required to create login role ${role.name} (${role.key}).`);
        }
        await sql`
          create role ${sql.ref(name)} login password ${sql.lit(password)}
          nosuperuser nobypassrls nocreatedb nocreaterole noreplication
        `.execute(admin);
      } else {
        await sql`
          create role ${sql.ref(name)} nologin nosuperuser nocreatedb
          nocreaterole noinherit nobypassrls noreplication
        `.execute(admin);
      }
      result.created.push(role.name);
    } else if (role.login && options.rotatePasswords?.[role.key]) {
      const password = options.passwords[role.key];
      if (!password) {
        throw new Error(`A password is required to rotate login role ${role.name} (${role.key}).`);
      }
      await sql`alter role ${sql.ref(name)} login password ${sql.lit(password)}`.execute(admin);
      result.rotated.push(role.name);
    } else {
      result.unchanged.push(role.name);
    }
    if (role.migratorMember && options.migratorRole) {
      const migrator = identifier(options.migratorRole);
      // The DIRECT edge with INHERIT and SET is the grant the contract
      // requires. pg_has_role answers for the whole graph, so an indirect
      // membership — or a direct one carrying neither option while a third
      // role supplies the privilege — would leave provisioning idempotent
      // against a contract verifyDatabaseRoles refuses.
      const membership = await sql<{ granted: boolean; superuser: boolean }>`
        select exists (select 1 from pg_auth_members am
            join pg_roles role on role.oid = am.roleid
            join pg_roles member on member.oid = am.member
            where role.rolname = ${name} and member.rolname = ${migrator}
              and am.inherit_option and am.set_option) as granted,
          (select rolsuper from pg_roles where rolname = ${migrator}) as superuser
      `.execute(admin);
      const row = membership.rows[0];
      if (row && !row.granted && !row.superuser) {
        await sql`
          grant ${sql.ref(name)} to ${sql.ref(migrator)}
          with inherit true, set true
        `.execute(admin);
        result.granted.push(`${name} -> ${migrator}`);
      }
    }
  }
  return result;
}
