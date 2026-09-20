// SPDX-License-Identifier: BUSL-1.1
/**
 * Who a login is, in entity terms — authored once, read by the API.
 *
 * The auth layer links a login to a party record, creates that party on a
 * first visit, finds candidates by e-mail, links a tenant to the party that
 * is the organization, and gates who may do any of that. None of those are
 * platform facts: which entity a party is, which field says it is a person
 * or an organization, where the login e-mail lives and which role
 * administers the organization are the deployment's vocabulary, so
 * `authorization.yaml` declares them under `identity:` and the compiler
 * emits them beside the other realm artifacts after checking every name
 * against the compiled entities and the realm's roles. The engine then reads
 * the contract instead of spelling `erp.*` tables and role names itself.
 *
 * The platform schema keeps its own references to the acting party
 * (`platform.tenants.relation_id`, `platform.identity_relations.*`): it is
 * loaded before the entities are compiled, so those references are authored
 * there and checked here against the contract rather than derived from it.
 */
import type { AuthorizationConfigFile, CompiledEntityContract, CompiledField } from "./types.js";

export const IDENTITY_CONTRACT_PATH = "apps/api/src/generated/compiler/identity.json";

export type IdentityContract = NonNullable<AuthorizationConfigFile["identity"]>;

type Entity = Pick<CompiledEntityContract, "entity" | "model" | "storage" | "authorization">;

/** A platform-schema reference to the acting party, as `schema.table`. */
export type PlatformPartyReference = { from: string; to: string };

function fieldOf(entities: ReadonlyMap<string, Entity>, entity: string, field: string, at: string): CompiledField {
  const known = entities.get(entity);
  if (!known) throw new Error(`identity.${at} names entity "${entity}", which is not compiled.`);
  const found = known.model.fields.find((candidate) => candidate.key === field);
  if (!found) {
    throw new Error(`identity.${at} names field "${field}", which entity "${entity}" does not have.`);
  }
  return found;
}

function scalar(field: CompiledField, baseType: "string" | "boolean", at: string): void {
  if (field.cardinality !== "single" || field.baseType !== baseType || field.relationship) {
    throw new Error(`identity.${at} must name a single ${baseType} field, not ${field.key}.`);
  }
}

function reference(field: CompiledField, target: string, at: string): void {
  if (field.cardinality !== "single" || field.relationship?.kind !== "belongsTo" || field.relationship.target !== target) {
    throw new Error(`identity.${at} must name a belongsTo reference to ${target}, not ${field.key}.`);
  }
}

/**
 * The roles the tenant realm's entity-role client holds: the hand-authored
 * ones plus every role an entity's authorization block derives.
 */
function realmRoles(configs: readonly AuthorizationConfigFile[], entities: readonly Entity[]): Set<string> {
  const roles = new Set<string>();
  for (const config of configs) {
    const client = config.keycloak.entityRoleClient;
    for (const role of client ? (config.clientRoles?.[client] ?? []) : []) roles.add(role);
    for (const client of Object.values(config.clientRoleComposites ?? {})) {
      for (const role of Object.keys(client)) roles.add(role);
    }
  }
  for (const entity of entities) {
    for (const set of Object.values(entity.authorization.roles)) for (const role of set) roles.add(role);
  }
  return roles;
}

/**
 * The one identity contract of the realm authoring, validated against the
 * compiled entities, the realm's roles and the platform schema's references
 * to the acting party. Exactly one authorization file may declare it.
 */
export function buildIdentityContract(
  configs: readonly AuthorizationConfigFile[],
  entities: readonly Entity[],
  options: { platformPartyReferences?: readonly PlatformPartyReference[]; schemaByModule?: Record<string, string> } = {},
): IdentityContract {
  const declared = configs.flatMap((config) => (config.identity ? [config.identity] : []));
  if (declared.length !== 1) {
    throw new Error(`Exactly one authorization file must declare identity:, found ${declared.length}.`);
  }
  const contract = declared[0]!;
  const byName = new Map(entities.map((entity) => [entity.entity.name, entity]));
  const { actingParty, person, loginContact } = contract;

  scalar(fieldOf(byName, actingParty.entity, actingParty.nameField, "actingParty.nameField"), "string", "actingParty.nameField");
  scalar(fieldOf(byName, actingParty.entity, actingParty.typeField, "actingParty.typeField"), "string", "actingParty.typeField");
  scalar(fieldOf(byName, actingParty.entity, actingParty.statusField, "actingParty.statusField"), "string", "actingParty.statusField");
  scalar(fieldOf(byName, actingParty.entity, actingParty.profileField, "actingParty.profileField"), "string", "actingParty.profileField");
  if (actingParty.personType === actingParty.organizationType) {
    throw new Error("identity.actingParty.personType and organizationType must differ.");
  }
  reference(fieldOf(byName, person.entity, person.relationField, "person.relationField"), actingParty.entity, "person.relationField");
  scalar(fieldOf(byName, person.entity, person.firstNameField, "person.firstNameField"), "string", "person.firstNameField");
  scalar(fieldOf(byName, person.entity, person.lastNameField, "person.lastNameField"), "string", "person.lastNameField");
  reference(fieldOf(byName, loginContact.entity, loginContact.relationField, "loginContact.relationField"), actingParty.entity, "loginContact.relationField");
  scalar(fieldOf(byName, loginContact.entity, loginContact.typeField, "loginContact.typeField"), "string", "loginContact.typeField");
  scalar(fieldOf(byName, loginContact.entity, loginContact.valueField, "loginContact.valueField"), "string", "loginContact.valueField");
  scalar(fieldOf(byName, loginContact.entity, loginContact.primaryField, "loginContact.primaryField"), "boolean", "loginContact.primaryField");
  scalar(fieldOf(byName, loginContact.entity, loginContact.statusField, "loginContact.statusField"), "string", "loginContact.statusField");

  const roles = realmRoles(configs, entities);
  for (const role of [contract.administratorRole, ...contract.memberRoles]) {
    if (!roles.has(role)) throw new Error(`identity names role "${role}", which no realm client or entity declares.`);
  }
  if (contract.memberRoles.length === 0) throw new Error("identity.memberRoles must name at least one role.");

  const party = byName.get(actingParty.entity)!;
  const schema = options.schemaByModule?.[party.entity.module] ?? party.entity.module;
  const partyTable = `${schema}.${party.storage.table}`;
  for (const entry of options.platformPartyReferences ?? []) {
    if (entry.to !== partyTable) {
      throw new Error(
        `${entry.from} references ${entry.to}, but identity.actingParty is ${actingParty.entity} at ${partyTable}.`,
      );
    }
  }

  return {
    administratorRole: contract.administratorRole,
    memberRoles: [...contract.memberRoles].sort(),
    actingParty: { ...actingParty },
    person: { ...person },
    loginContact: { ...loginContact },
  };
}

export function renderIdentityContract(contract: IdentityContract): string {
  return `${JSON.stringify(contract, null, 2)}\n`;
}
