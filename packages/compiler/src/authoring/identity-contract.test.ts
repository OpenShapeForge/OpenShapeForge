// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { buildIdentityContract } from "./identity-contract.js";
import type { AuthorizationConfigFile } from "./types.js";

const identity: NonNullable<AuthorizationConfigFile["identity"]> = {
  administratorRole: "Organization.All.ReadWrite",
  memberRoles: ["General.All.Read"],
  actingParty: {
    entity: "Relation", nameField: "displayName", typeField: "relationType",
    personType: "person", organizationType: "organization",
    statusField: "status", activeStatus: "active", profileField: "businessContext",
  },
  person: { entity: "NaturalPerson", relationField: "relationId", firstNameField: "firstName", lastNameField: "lastName" },
  loginContact: {
    entity: "ContactDetail", relationField: "relationId", typeField: "type", emailType: "email",
    valueField: "value", primaryField: "isPrimary", statusField: "status", activeStatus: "active",
  },
};

const config = (block = identity, clientRoles: string[] = ["Organization.All.ReadWrite", "General.All.Read"]): AuthorizationConfigFile =>
  ({
    schemaVersion: 2,
    kind: "authorizationConfig",
    keycloak: { entityRoleClient: "erp-provider" },
    clientRoles: { "erp-provider": clientRoles },
    identity: block,
  }) as AuthorizationConfigFile;

type Field = { key: string; baseType?: string; cardinality?: string; relationship?: { kind: string; target: string } };
const entity = (name: string, table: string, fields: Field[]) =>
  ({
    entity: { name, module: "core" },
    storage: { table },
    authorization: { roles: { read: [`${name}s.All.Read`], create: [], update: [], delete: [] } },
    model: {
      fields: fields.map((field) => ({ baseType: "string", cardinality: "single", ...field })),
    },
  }) as never;

const belongsTo = (key: string) => ({ key, relationship: { kind: "belongsTo", target: "Relation" } });
const entities = [
  entity("Relation", "relations", [{ key: "displayName" }, { key: "relationType" }, { key: "status" }, { key: "businessContext" }]),
  entity("NaturalPerson", "natural_persons", [belongsTo("relationId"), { key: "firstName" }, { key: "lastName" }]),
  entity("ContactDetail", "contact_details", [
    belongsTo("relationId"), { key: "type" }, { key: "value" }, { key: "isPrimary", baseType: "boolean" }, { key: "status" },
  ]),
];
const platform = { schemaByModule: { core: "erp" }, platformPartyReferences: [{ from: "platform.tenants.relation_id", to: "erp.relations" }] };

describe("identity contract", () => {
  test("carries the authored vocabulary, roles sorted", () => {
    const built = buildIdentityContract([config({ ...identity, memberRoles: ["General.All.Read", "Relations.All.Read"] })], entities, platform);
    expect(built.actingParty.entity).toBe("Relation");
    expect(built.actingParty.profileField).toBe("businessContext");
    expect(built.memberRoles).toEqual(["General.All.Read", "Relations.All.Read"]);
  });

  test("refuses a field no compiled entity has, and a missing or doubled block", () => {
    const wrong = { ...identity, loginContact: { ...identity.loginContact, valueField: "address" } };
    expect(() => buildIdentityContract([config(wrong)], entities)).toThrow(/loginContact.valueField/);
    expect(() => buildIdentityContract([config(), config()], entities)).toThrow(/Exactly one/);
    expect(() => buildIdentityContract([], entities)).toThrow(/Exactly one/);
  });

  test("holds every field to its shape: scalars single-valued, references pointing at the party", () => {
    const boolName = { ...identity, actingParty: { ...identity.actingParty, nameField: "status" } };
    expect(() => buildIdentityContract([config({ ...identity, loginContact: { ...identity.loginContact, primaryField: "value" } })], entities))
      .toThrow(/loginContact.primaryField must name a single boolean field/);
    expect(() => buildIdentityContract([config({ ...identity, person: { ...identity.person, relationField: "firstName" } })], entities))
      .toThrow(/person.relationField must name a belongsTo reference to Relation/);
    expect(() => buildIdentityContract([config({ ...identity, actingParty: { ...identity.actingParty, organizationType: "person" } })], entities))
      .toThrow(/personType and organizationType must differ/);
    expect(buildIdentityContract([config(boolName)], entities).actingParty.nameField).toBe("status");
  });

  test("refuses a role the realm does not declare", () => {
    expect(() => buildIdentityContract([config(identity, ["General.All.Read"])], entities))
      .toThrow(/role "Organization.All.ReadWrite", which no realm client or entity declares/);
    // An entity-derived role counts as declared.
    expect(buildIdentityContract([config({ ...identity, memberRoles: ["Relations.All.Read"] }, ["Organization.All.ReadWrite"])], entities).memberRoles)
      .toEqual(["Relations.All.Read"]);
  });

  test("holds the platform schema's party references to the acting party's table", () => {
    expect(() => buildIdentityContract([config()], entities, {
      ...platform,
      platformPartyReferences: [{ from: "platform.tenants.relation_id", to: "erp.accounts" }],
    })).toThrow(/platform.tenants.relation_id references erp.accounts, but identity.actingParty is Relation at erp.relations/);
  });
});
