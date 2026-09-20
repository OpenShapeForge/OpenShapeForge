// SPDX-License-Identifier: BUSL-1.1
/**
 * The identity contract: which authored entities and fields a login maps to.
 *
 * This is the DEPLOYMENT's vocabulary, not the engine's. The engine knows a
 * login acts as some party, a party may be a person with a name, and a party
 * is reached by an e-mail contact; which entity plays each part, what its
 * fields are called and which values mean "person", "e-mail" and "active"
 * are authored in `authorization.yaml` (`identity:`) and arrive here as
 * `generated/compiler/identity.json`. Nothing in apps/api/src/auth spells a
 * table, column, relation type or role name by hand: it reads the contract
 * and resolves entities and fields to physical names through the generated
 * manifest (db/manifest-lookup.ts). The type is declared locally in the
 * JSON's shape — apps/api imports no compiler types (compare ./person-roles.ts).
 */
import generatedContract from "../generated/compiler/identity.json" with { type: "json" };
import { entityColumnName, entityTableName } from "../db/manifest-lookup.js";

export type IdentityContract = {
  /** The organization-administrator role; gates every membership tool. */
  administratorRole: string;
  /** What a session may do before an administrator assigned it a role. */
  memberRoles: readonly string[];
  /** The party a login acts as (Relation, in the default authoring). */
  actingParty: {
    entity: string;
    nameField: string;
    typeField: string;
    personType: string;
    organizationType: string;
    statusField: string;
    activeStatus: string;
    profileField: string;
  };
  /** The person record hanging off a party of `personType`. */
  person: { entity: string; relationField: string; firstNameField: string; lastNameField: string };
  /** The contact record an e-mail login is matched against. */
  loginContact: {
    entity: string;
    relationField: string;
    typeField: string;
    emailType: string;
    valueField: string;
    primaryField: string;
    statusField: string;
    activeStatus: string;
  };
};

export const IDENTITY_CONTRACT: IdentityContract = generatedContract as IdentityContract;

/** Columns every tenant-scoped authored table carries under these fixed names. */
const FIXED_COLUMNS = { id: "id", tenantId: "tenant_id" } as const;

/** `schema.table` of the acting-party entity. */
export const actingPartyTable = (): string => entityTableName(IDENTITY_CONTRACT.actingParty.entity);

/** Physical columns of the acting-party entity's contract fields. */
export function actingPartyColumns() {
  const { entity, nameField, typeField, statusField, profileField } = IDENTITY_CONTRACT.actingParty;
  return {
    ...FIXED_COLUMNS,
    name: entityColumnName(entity, nameField),
    type: entityColumnName(entity, typeField),
    status: entityColumnName(entity, statusField),
    profile: entityColumnName(entity, profileField),
  };
}

/** `schema.table` of the person entity. */
export const personTable = (): string => entityTableName(IDENTITY_CONTRACT.person.entity);

/** Physical columns of the person entity's contract fields. */
export function personColumns() {
  const { entity, relationField, firstNameField, lastNameField } = IDENTITY_CONTRACT.person;
  return {
    ...FIXED_COLUMNS,
    relation: entityColumnName(entity, relationField),
    firstName: entityColumnName(entity, firstNameField),
    lastName: entityColumnName(entity, lastNameField),
  };
}

/** `schema.table` of the login-contact entity. */
export const loginContactTable = (): string => entityTableName(IDENTITY_CONTRACT.loginContact.entity);

/** Physical columns of the login-contact entity's contract fields. */
export function loginContactColumns() {
  const { entity, relationField, typeField, valueField, primaryField, statusField } =
    IDENTITY_CONTRACT.loginContact;
  return {
    ...FIXED_COLUMNS,
    relation: entityColumnName(entity, relationField),
    type: entityColumnName(entity, typeField),
    value: entityColumnName(entity, valueField),
    primary: entityColumnName(entity, primaryField),
    status: entityColumnName(entity, statusField),
  };
}
