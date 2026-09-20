// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { buildIdentityContract } from "./identity-contract.js";
import type { AuthorizationConfigFile } from "./types.js";

const identity: NonNullable<AuthorizationConfigFile["identity"]> = {
  administratorRole: "Organization.All.ReadWrite",
  memberRoles: ["General.All.Read"],
  actingParty: {
    entity: "Relation", nameField: "displayName", typeField: "relationType",
    personType: "person", statusField: "status", activeStatus: "active",
  },
  person: { entity: "NaturalPerson", relationField: "relationId", firstNameField: "firstName", lastNameField: "lastName" },
  loginContact: {
    entity: "ContactDetail", relationField: "relationId", typeField: "type", emailType: "email",
    valueField: "value", primaryField: "isPrimary", statusField: "status", activeStatus: "active",
  },
};

const config = (block = identity): AuthorizationConfigFile =>
  ({ schemaVersion: 2, kind: "authorizationConfig", keycloak: {}, identity: block }) as AuthorizationConfigFile;

const entity = (name: string, fields: string[]) =>
  ({ entity: { name }, model: { fields: fields.map((key) => ({ key })) } }) as never;

const entities = [
  entity("Relation", ["displayName", "relationType", "status"]),
  entity("NaturalPerson", ["relationId", "firstName", "lastName"]),
  entity("ContactDetail", ["relationId", "type", "value", "isPrimary", "status"]),
];

describe("identity contract", () => {
  test("carries the authored vocabulary, roles sorted", () => {
    const built = buildIdentityContract([config({ ...identity, memberRoles: ["b", "a"] })], entities);
    expect(built.actingParty.entity).toBe("Relation");
    expect(built.memberRoles).toEqual(["a", "b"]);
  });

  test("refuses a field no compiled entity has, and a missing or doubled block", () => {
    const wrong = { ...identity, loginContact: { ...identity.loginContact, valueField: "address" } };
    expect(() => buildIdentityContract([config(wrong)], entities)).toThrow(/loginContact.valueField/);
    expect(() => buildIdentityContract([config(), config()], entities)).toThrow(/Exactly one/);
    expect(() => buildIdentityContract([], entities)).toThrow(/Exactly one/);
  });
});
