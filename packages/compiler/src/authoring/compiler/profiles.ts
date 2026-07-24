// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * Profile compiler — compiles profile-specific configuration for context extensions
 * (e.g., sector standards, third-party API projections).
 *
 * Pipeline position: called by the main compiler alongside other sub-compilers.
 * Merges each EntityProfile with its matching EntityMapping to produce identity
 * mappings, field mappings, profile table names, and optional third-party API config.
 *
 * Input:  EntityProfile[], EntityMapping[].
 * Output: Record<string, CompiledProfile> — keyed by profile name.
 */
import type { EntityProfile, EntityMapping, CompiledProfile } from "../types.js";
import { deriveTableName } from "./helpers.js";

export function buildProfiles(
  profiles: EntityProfile[],
  mappings: EntityMapping[]
): Record<string, CompiledProfile> {
  const result: Record<string, CompiledProfile> = {};

  for (const profile of profiles) {
    const mapping = mappings.find((m) => m.profile === profile.profile);

    const compiled: CompiledProfile = {
      entityName: profile.entity,
      profileTable: profile.storage?.profileTable ?? `${deriveTableName(profile.extends)}_profiles_${profile.profile}`,
      mapping: {
        identity: mapping
          ? { source: mapping.identityMapping.source, target: mapping.identityMapping.target }
          : { source: "id", target: "id" },
        fieldMappings: mapping?.fieldMappings ?? [],
      },
      ...(profile.displayTemplate ? { displayTemplate: profile.displayTemplate } : {}),
      ...(profile.filterField ? { filterField: profile.filterField } : {}),
    };

    if (profile.projection?.thirdPartyApi) {
      compiled.thirdPartyApi = {
        purpose: profile.projection.thirdPartyApi.purpose ?? "Third-party REST API",
        entityName: profile.projection.thirdPartyApi.entityName,
        endpoints: profile.projection.thirdPartyApi.endpoints,
      };
    }

    result[profile.profile] = compiled;
  }

  return result;
}
