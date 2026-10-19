// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createDatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { withDbSession } from "../db/session.js";
import { APP_ROLE } from "../db/migrations/app-role.js";
import { IDENTITY_LINK_ADMIN_ROLE } from "../auth/organization-roles.js";
import { readAvailableTenants } from "./available-tenants.js";
import type { GraphqlContext } from "./context.js";

test("native membership intersects own admitted or invited access, with RLS retained and live revocation", async () => {
  const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
  if (new URL(adminUrl).pathname !== "/postgres") throw Error("Use the administrator postgres database for this isolated proof");
  const name = `tenant_choices_${randomUUID().replaceAll("-", "").slice(0,12)}`;
  const admin = new SQL(adminUrl, { max: 1 });
  const ownUrl = new URL(adminUrl); ownUrl.pathname = "/" + name;
  await admin.unsafe(`create database "${name}"`);
  const privileged = createDatabaseRuntime({ databaseUrl: ownUrl.toString(), maxConnections: 1 });
  ownUrl.username = ownUrl.password = APP_ROLE;
  const restricted = createDatabaseRuntime({ databaseUrl: ownUrl.toString(), maxConnections: 2 });
  const userId=randomUUID(), identityId=randomUUID(), foreignIdentity=randomUUID(), collisionIdentity=randomUUID();
  const issuer="https://identity.example/realms/test";
  const email="owner@example.test";
  const kinds=["own","second","blocked","unadmitted","foreign","inactive","provider-disabled","issuer-collision","invited","revoked","not-native"];
  const tenants=kinds.map((kind) => ({ kind, id:randomUUID(), org:randomUUID() }));
  try {
    await privileged.db.connection().execute(conn => runMigrationChain(conn));
    await privileged.db.transaction().execute(async tx => {
      await sql`select set_config('app.roles',${IDENTITY_LINK_ADMIN_ROLE},true)`.execute(tx);
      await sql`insert into platform.identities(id,issuer,subject,email) values
        (${identityId},${issuer},${userId},${email}),
        (${foreignIdentity},${issuer},${randomUUID()},'foreign@example.test'),
        (${collisionIdentity},'https://other.example/realms/test',${userId},${email})`.execute(tx);
      for (const tenant of tenants) {
        await sql`insert into platform.tenants(id,slug,name,status,keycloak_realm,keycloak_organization_id)
          values(${tenant.id},${"choices-"+tenant.kind},${tenant.kind},${tenant.kind==='inactive'?'inactive':'active'},'test',${tenant.org})`.execute(tx);
        if (["unadmitted","invited","revoked"].includes(tenant.kind)) continue;
        const relation=randomUUID();
        await sql`insert into erp.relations(id,tenant_id,display_name,relation_type,status)
          values(${relation},${tenant.id},'Member','person','active')`.execute(tx);
        await sql`insert into platform.identity_relations(identity_id,tenant_id,status,relation_id,linked_at,linked_by,roles,access_blocked)
          values(${tenant.kind==='foreign'?foreignIdentity:tenant.kind==='issuer-collision'?collisionIdentity:identityId},${tenant.id},'linked',${relation},now(),'proof',array['org_admin'],${tenant.kind==='blocked'})`.execute(tx);
      }
      for (const kind of ["invited","revoked"]) {
        const tenant=tenants.find(t=>t.kind===kind)!;
        await sql`insert into platform.employee_invitations(tenant_id,email,role,status,invited_by,revoked_at)
          values(${tenant.id},${email},null,${kind==='invited'?'pending':'revoked'},'proof',${kind==='revoked'?sql`now()`:null})`.execute(tx);
      }
    });
    const session={tenantId:tenants[0]!.id,userId,issuer,verifiedEmail:email,credential:'bearer' as const,principalKind:'person' as const,roles:['org_admin'],groups:[],scope:'tenant' as const};
    const context={db:restricted.db,session} as GraphqlContext;
    let memberships=tenants.filter(t=>t.kind!=='not-native').map(t=>({id:t.org,enabled:t.kind!=='provider-disabled'}));
    const source=()=>({realm:'test',issuer,list:async(subject:string)=>{expect(subject).toBe(userId);return memberships;}});
    expect((await readAvailableTenants(context,source)).map(t=>t.name)).toEqual(['invited','own','second']);
    const { verifiedEmail: _email, ...unverifiedSession } = session;
    expect((await readAvailableTenants({...context,session:unverifiedSession},source)).map(t=>t.name)).toEqual(['own','second']);
    // Discovery does not admit an invitation or write roles.
    expect((await sql<{status:string}>`select status from platform.employee_invitations where tenant_id=${tenants.find(t=>t.kind==='invited')!.id}`.execute(privileged.db)).rows[0]!.status).toBe('pending');
    await withDbSession(restricted.db,session,async tx=>{
      const rows=await sql<{id:string}>`select id from platform.tenants`.execute(tx);
      expect(rows.rows.map(r=>r.id)).toEqual([session.tenantId]);
      expect((await sql<{bypass:string}>`select current_setting('app.bypass_rls',true) as bypass`.execute(tx)).rows[0]?.bypass).not.toBe('on');
    });
    memberships=memberships.filter(m=>m.id!==tenants[1]!.org);
    expect((await readAvailableTenants(context,source)).map(t=>t.name)).toEqual(['invited','own']);
    memberships.push({id:tenants[1]!.org,enabled:true});
    await privileged.db.transaction().execute(async tx => {
      await sql`select set_config('app.roles',${IDENTITY_LINK_ADMIN_ROLE},true)`.execute(tx);
      await sql`update platform.identity_relations set access_blocked=true where tenant_id=${tenants[1]!.id}`.execute(tx);
    });
    expect((await readAvailableTenants(context,source)).map(t=>t.name)).toEqual(['invited','own']);
  } finally {
    await restricted.close();await privileged.close();
    await admin.unsafe(`drop database "${name}" with (force)`);await admin.close();
  }
},90000);
