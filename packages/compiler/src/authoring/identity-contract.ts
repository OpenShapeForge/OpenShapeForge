// SPDX-License-Identifier: BUSL-1.1
/**
 * Who a login is, in entity terms — authored once, read by the API.
 *
 * The auth layer links a login to a party record, creates that party on a
 * first visit, finds candidates by e-mail and gates who may do any of that.
 * None of those are platform facts: which entity a party is, which field says
 * it is a person, where the login e-mail lives and which role administers the
 * organization are the deployment's vocabulary, so `authorization.yaml`
 * declares them under `identity:` and the compiler emits them beside the
 * other realm artifacts after checking that every named entity and field
 * exists. The engine then reads the contract instead of spelling `erp.*`
 * tables and role names itself.
 */
import type { AuthorizationConfigFile, CompiledEntityContract } from "./types.js";

export const IDENTITY_CONTRACT_PATH = "apps/api/src/generated/compiler/identity.json";

export type IdentityContract = {
  /** The role that may link identities, invite employees and assign roles. */
  administratorRole: string;
  /** What a just-in-time member holds until an administrator assigns roles. */
  memberRoles: string[];
  /** The party a login acts as. */
  actingParty: {
    entity: string;
    nameField: string;
    typeField: string;
    /** The `typeField` value of a natural person. */
    personType: string;
    statusField: string;
    /** The `statusField` value a newly created party carries. */
    activeStatus: string;
  };
  /** The person record created beside a person party. */
  person: {
    entity: string;
    relationField: string;
    firstNameField: string;
    lastNameField: string;
  };
  /** Where a party's e-mail addresses live. */
  loginContact: {
    entity: string;
    relationField: string;
    typeField: string;
    /** The `typeField` value of an e-mail address. */
    emailType: string;
    valueField: string;
    primaryField: string;
    statusField: string;
    activeStatus: string;
  };
};

type EntityFields = ReadonlyMap<string, ReadonlySet<string>>;

function requireField(fields: EntityFields, entity: string, field: string, at: string): void {
  const known = fields.get(entity);
  if (!known) throw new Error(`identity.${at} names entity "${entity}", which is not compiled.`);
  if (!known.has(field)) {
    throw new Error(`identity.${at} names field "${field}", which entity "${entity}" does not have.`);
  }
}

/**
 * The one identity contract of the realm authoring, validated against the
 * compiled entities. Exactly one authorization file may declare it.
 */
export function buildIdentityContract(
  configs: readonly AuthorizationConfigFile[],
  entities: readonly Pick<CompiledEntityContract, "entity" | "model">[],
): IdentityContract {
  const declared = configs.flatMap((config) => (config.identity ? [config.identity] : []));
  if (declared.length !== 1) {
    throw new Error(
      `Exactly one authorization file must declare identity:, found ${declared.length}.`,
    );
  }
  const contract = declared[0]!;
  const fields: EntityFields = new Map(
    entities.map((entity) => [
      entity.entity.name,
      new Set(entity.model.fields.map((field) => field.key)),
    ]),
  );
  const { actingParty, person, loginContact } = contract;
  for (const field of ["nameField", "typeField", "statusField"] as const) {
    requireField(fields, actingParty.entity, actingParty[field], `actingParty.${field}`);
  }
  for (const field of ["relationField", "firstNameField", "lastNameField"] as const) {
    requireField(fields, person.entity, person[field], `person.${field}`);
  }
  for (const field of ["relationField", "typeField", "valueField", "primaryField", "statusField"] as const) {
    requireField(fields, loginContact.entity, loginContact[field], `loginContact.${field}`);
  }
  if (contract.memberRoles.length === 0) {
    throw new Error("identity.memberRoles must name at least one role.");
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
