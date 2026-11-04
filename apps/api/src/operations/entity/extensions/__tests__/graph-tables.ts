// SPDX-License-Identifier: BUSL-1.1
/**
 * The definitions and the dependency graph of tenant fields, for a scratch
 * schema mirrored by hand. In the test composition a tenant reference may name
 * nearly every entity, so a write of any of them asks the graph what reads the
 * record (extensions/linked.ts). Empty here: these schemas are about something
 * else. Goes after `create schema platform`, before its grants.
 */
export const EXTENSION_GRAPH_TABLES = `
  create table platform.extension_field_definitions(id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    field_id uuid not null, entity text not null, key text not null, version integer not null, kind text not null,
    definition jsonb not null, applies_when jsonb, state text not null, position integer not null, is_current boolean not null,
    created_at timestamptz not null default now(), created_by uuid, suspended_reason text);
  create table platform.extension_field_dependencies(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, field_id uuid not null,
    depends_on_entity text not null, depends_on_field text not null, via_field text);
`;
