// SPDX-License-Identifier: BUSL-1.1
/**
 * Canonical role-name vocabulary shared by the Keycloak realm generator and
 * the backend manifest's authorization bridge. Lives outside generators/ so
 * type-checked modules (backend-manifest.ts) can import it without depending
 * on the @ts-nocheck generator.
 */

/**
 * Dutch→English module-name aliases used to translate entity-yaml roles
 * (e.g. `Vastgoed.All.Read`) into the realm-composite shape Keycloak imports
 * (`RealEstate.All.Read`). Exported so the access-control UI E2E oracle can
 * reuse the exact mapping without duplicating it.
 */
export const KEYCLOAK_ROLE_SEGMENT_RENAMES: Record<string, string> = {
  Algemeen: "General",
  Dossier: "CaseFile",
  Energie: "Energy",
  Financien: "Finance",
  Kwaliteit: "Quality",
  Onderhoud: "Maintenance",
  Organisatie: "Organization",
  Overeenkomsten: "Agreements",
  Projectontwikkeling: "ProjectDevelopment",
  Relaties: "Relations",
  Vastgoed: "RealEstate",
  Woonruimteverdeling: "HousingAllocation",
  Zaken: "Cases",
};

/**
 * Translate a Dutch-segment role name (e.g. `Vastgoed.All.Read`) to its
 * Keycloak-canonical English form (`RealEstate.All.Read`). Exported for the
 * UI authorization oracle.
 */
export function normalizeKeycloakRoleName(roleName: string): string {
  return roleName
    .split(".")
    .map((segment) => KEYCLOAK_ROLE_SEGMENT_RENAMES[segment] ?? segment)
    .join(".");
}
