// SPDX-License-Identifier: BUSL-1.1
import { HttpError } from "../rest/http-error.js";

/**
 * Authentication could not be decided: the bearer verifier or the database
 * behind the identity ↔ Relation link was unavailable. Distinct from a refusal
 * — the caller must answer 503, never an anonymous or partial session. A leaf
 * module because both identity.ts and identity-link.ts throw it and the
 * latter is imported by the former.
 */
export class SessionAuthenticationUnavailableError extends HttpError {
  constructor(message = "Authentication is unavailable.") {
    super(503, "AUTHENTICATION_UNAVAILABLE", message);
    this.name = "SessionAuthenticationUnavailableError";
  }
}
