// SPDX-License-Identifier: BUSL-1.1
import { parseUserProfile, readJwtClaims } from "@openshapeforge/auth";
import {
  getSession,
  replaceSessionIfUnchanged,
  type StoredSession,
} from "../redis";
import { mergeUserProfileIntoStoredSession } from "./claims";

export interface SessionHydrationDependencies {
  getSession: (sessionId: string) => Promise<StoredSession | null>;
  replaceSession: (
    sessionId: string,
    expected: StoredSession,
    replacement: StoredSession,
  ) => Promise<boolean>;
}

const defaultDependencies: SessionHydrationDependencies = {
  getSession,
  replaceSession: replaceSessionIfUnchanged,
};

function profileChanged(current: StoredSession, hydrated: StoredSession): boolean {
  return hydrated.name !== current.name
    || hydrated.givenName !== current.givenName
    || hydrated.familyName !== current.familyName
    || hydrated.preferredUsername !== current.preferredUsername
    || hydrated.email !== current.email;
}

/**
 * Backfill profile fields without letting an unlocked session callback restore
 * a record deleted by logout. A lost compare-and-set returns the current Redis
 * value; null means logout won and the caller must fail closed.
 */
export async function hydrateStoredSessionProfile(
  sessionId: string,
  stored: StoredSession,
  dependencies: SessionHydrationDependencies = defaultDependencies,
): Promise<StoredSession | null> {
  const hydratedProfile = parseUserProfile({
    sub: stored.sub,
    stored,
    idTokenClaims: readJwtClaims(stored.idToken),
    accessTokenClaims: readJwtClaims(stored.accessToken),
  });
  const hydrated = mergeUserProfileIntoStoredSession(stored, hydratedProfile);
  if (!profileChanged(stored, hydrated)) {
    return stored;
  }

  if (await dependencies.replaceSession(sessionId, stored, hydrated)) {
    return hydrated;
  }
  return dependencies.getSession(sessionId);
}
