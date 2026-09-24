// SPDX-License-Identifier: BUSL-1.1
/**
 * The platform operator identity: what a verified control-realm operator is on
 * the far side of the door (`control-session.ts`), and how one becomes a
 * system-bypass database session for one Operation.
 *
 * The single marker role is `platform-operator` (`authorization.ts`). It
 * authorizes every control Operation: tenant lifecycle, organization state,
 * reconciliation, catalog, notices and audit.
 *
 * The elevation is the operator's, made in the same place: an administrator
 * becomes a `Platform.SystemBypass` database session for exactly one call,
 * with an issuer-qualified actor and a reason naming the Operation and its
 * target (`systemSessionForOperator`). No tenant, no organization: a platform
 * session names every tenant by slug and nothing in a token picks one.
 */
import { systemSessionForOperator } from "./authorization.js";
import type { SystemSessionInput } from "../db/session.js";

/** An authenticated, authorized platform operator. */
export type PlatformAdministrator = {
  /** The `sub` claim, unique within `issuer` and only within it. */
  subject: string;
  /** The control realm that vouched for the subject. */
  issuer: string;
  /** `preferred_username`, for audit context. */
  username: string | undefined;
  /** `name`, else `preferred_username`; display only. */
  name: string | null;
  email: string | null;
  /** The OAuth client the token was issued to (`azp`); display only. */
  authorizedParty: string;
  /** Token expiry in epoch milliseconds; null when the token carries none. */
  expiresAtMs: number | null;
};

/**
 * The elevation for one call. `reason` names the Operation and its target so
 * `platform.system_bypass_audit` reads as a log of what the administrator did
 * (`platform-mcp: control.publish-catalog-entry service/record-finding`),
 * with the issuer-qualified actor and the timestamps the session layer
 * records. `platform-mcp` is the audit source label of the whole
 * platform-administration surface, whichever transport carried the call.
 */
export function systemSessionForAdministrator(
  administrator: PlatformAdministrator,
  reason: string,
): SystemSessionInput {
  // The operator's mapping, re-labelled: same actor form, same bypass role,
  // no tenant scope — the reason prefix is the only difference, so an audit
  // reader can tell the two surfaces apart.
  const session = systemSessionForOperator(
    {
      subject: administrator.subject,
      issuer: administrator.issuer,
      username: administrator.username,
    },
    reason,
  );
  return { ...session, reason: `platform-mcp: ${reason}` };
}
