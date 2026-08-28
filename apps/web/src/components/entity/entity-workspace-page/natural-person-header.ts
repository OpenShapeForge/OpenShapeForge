// SPDX-License-Identifier: BUSL-1.1
import { readDisplayValue, readRecordArray } from "./record-display";

export const naturalPersonWorkspaceHeaderQuery = `
  query NaturalPersonWorkspaceHeader($id: ID!) {
    naturalPerson(id: $id) {
      id
      firstName
      namePrefix
      lastName
      initials
      preferredLanguage
      nationality
      relation {
        id
        relationType
        roles {
          id
          type
          name
          startDate
          endDate
        }
      }
    }
  }
`;

function formatNaturalPersonDisplayName(entity: Record<string, unknown> | null | undefined): string {
  const parts = [
    readDisplayValue(entity, "firstName"),
    readDisplayValue(entity, "namePrefix"),
    readDisplayValue(entity, "lastName"),
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : "Natural person";
}

function isCurrentRelationRole(role: Record<string, unknown>, now = new Date()): boolean {
  const startDate = readDisplayValue(role, "startDate");
  const endDate = readDisplayValue(role, "endDate");
  const startsBeforeNow = startDate ? new Date(startDate) <= now : true;
  const endsAfterNow = endDate ? new Date(endDate) >= now : true;

  return startsBeforeNow && endsAfterNow;
}

const relationRoleLabels: Record<string, string> = {
  BEW: "Bewoner",
  HOO: "Hoofdbewoner",
  HUU: "Huurder",
  MDH: "Medehuurder",
};

function resolveRelationRoleLabel(role: Record<string, unknown>): string | undefined {
  const name = readDisplayValue(role, "name");
  if (name) {
    return name;
  }

  const type = readDisplayValue(role, "type");
  return type ? relationRoleLabels[type] ?? type : undefined;
}

function resolveNaturalPersonRoles(entity: Record<string, unknown>): string[] {
  const relation = entity.relation;
  const relationRecord =
    relation && typeof relation === "object" && !Array.isArray(relation)
      ? relation as Record<string, unknown>
      : undefined;
  const roles = readRecordArray(relationRecord?.roles);
  const currentRoles = roles.filter((role) => isCurrentRelationRole(role));
  const candidateRoles = currentRoles.length > 0 ? currentRoles : roles;
  const labels = candidateRoles
    .map(resolveRelationRoleLabel)
    .filter((role): role is string => Boolean(role));

  return Array.from(new Set(labels));
}

export function buildNaturalPersonHeaderEntity(entity: Record<string, unknown> | null | undefined) {
  if (!entity) {
    return null;
  }

  const title = formatNaturalPersonDisplayName(entity);
  const roles = resolveNaturalPersonRoles(entity);
  const chipCandidates = [
    readDisplayValue(entity, "nationality"),
    readDisplayValue(entity, "preferredLanguage"),
  ];
  const chips = chipCandidates.filter(Boolean) as string[];
  const initials = [
    readDisplayValue(entity, "firstName")?.charAt(0),
    readDisplayValue(entity, "lastName")?.charAt(0),
  ].filter(Boolean).join("").toUpperCase();

  return {
    title,
    role: roles.join(", ") || undefined,
    chips,
    initials: initials || undefined,
  };
}
