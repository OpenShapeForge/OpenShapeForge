// SPDX-License-Identifier: BUSL-1.1
/**
 * The browser flow of the passkey profile: who is let in, and by what.
 *
 * Split out of keycloak-passkeys.ts for size; the rule it serves (no password
 * execution anywhere) is argued in that file's header.
 *
 *   passkey-browser                                  (top level)
 *     auth-cookie                          ALTERNATIVE  existing SSO session
 *     identity-provider-redirector         ALTERNATIVE  kc_idp_hint
 *     passkey-browser-organization         ALTERNATIVE
 *       passkey-browser-organization-conditional  CONDITIONAL
 *         conditional-user-configured      REQUIRED
 *         organization                     ALTERNATIVE  identity-first, by e-mail domain
 *     passkey-browser-forms                ALTERNATIVE
 *       auth-username-form                 REQUIRED
 *       webauthn-authenticator-passwordless REQUIRED
 *
 * ── The Organization identity-first step ────────────────────────────────────
 * Keycloak's stock browser flow carries the same step (its "Organization"
 * sub-flow). It asks for the e-mail address first. When the domain belongs to
 * an Organization whose linked identity provider has
 * `kc.org.broker.redirect.mode.email-matches` set, the person is redirected to
 * that provider — e.g. a acme.example address goes to the Acme Google
 * Workspace. Otherwise the step records who the person is and gives way;
 * `auth-username-form` below then sees that user and skips its own page, so
 * the next thing on screen is the passkey prompt, as without this step.
 *
 * Measured on Keycloak 26.5.3 and 26.7.3, and Keycloak's rule, not ours:
 *   - Keycloak does NOT redirect a person who already holds a first-factor
 *     credential (a passkey here); they get the passkey prompt, so they can
 *     choose. On an Organization domain the provider is therefore the way in
 *     for everybody without a passkey — a new or unknown address included —
 *     and `kc_idp_hint` remains the way in for everybody else.
 *   - An address Keycloak does not know and no Organization claims gets the
 *     identity-first page back without an error, where the flow without this
 *     step said "Invalid username or email". Nobody is admitted either way.
 *
 * `conditional-user-configured` keeps the step inert in a realm whose
 * Organizations feature is off: the organization authenticator reports
 * itself not configured there, so the sub-flow is skipped and the forms
 * sub-flow renders the username page as before (also measured).
 *
 * ── Federation is an alternative to a passkey, on purpose ───────────────────
 * Both routes to an identity provider sit at ALTERNATIVE next to the passkey
 * sub-flow, so a broker login admits the person on its own. For a provider
 * linked to one tenant's Keycloak Organization (see
 * apps/api/src/control/keycloak-organization-admin.ts), that tenant IS the identity
 * authority for their domain, and their own Workspace MFA policy is what
 * guards the account. Demanding a second, product-specific passkey on top
 * makes the SSO they bought pointless.
 *
 * Stated plainly: the passkey-only guarantee is then only as strong as that
 * tenant's policy. A Workspace that still allows bare passwords re-opens a
 * password path — at Google, not here. Two things keep it from being a hole by
 * accident: `hideOnLogin: true` on the provider (no button on the login page;
 * only an address on a linked Organization domain is routed to it), and the
 * `webauthn-register-passwordless` required action being a DEFAULT action, so
 * a person who arrives over Workspace is still walked through enrolling a
 * passkey and ends up with one — after which, per the rule above, Keycloak
 * shows them the passkey prompt rather than the redirect.
 */

import type { KeycloakAuthenticationFlowExport } from "./keycloak-passkeys.js";

/** Top-level browser flow alias. */
export const PASSKEY_BROWSER_FLOW = "passkey-browser";
/** Sub-flow holding the Organization identity-first step. */
export const PASSKEY_ORGANIZATION_FLOW = "passkey-browser-organization";
/** The conditional sub-flow inside it; unique alias, so it cannot collide with the stock one. */
const PASSKEY_ORGANIZATION_CONDITIONAL_FLOW = "passkey-browser-organization-conditional";
/** Sub-flow holding the actual credential challenge. */
const PASSKEY_FORMS_FLOW = "passkey-browser-forms";

/** Keycloak's provider id for the passwordless (passkey) authenticator. */
const WEBAUTHN_PASSWORDLESS_AUTHENTICATOR = "webauthn-authenticator-passwordless";

export function passkeyBrowserFlows(): KeycloakAuthenticationFlowExport[] {
  return [
    {
      alias: PASSKEY_BROWSER_FLOW,
      description:
        "Passkey-only browser login. No password execution exists in this flow; see keycloak-passkeys.ts.",
      providerId: "basic-flow",
      topLevel: true,
      builtIn: false,
      authenticationExecutions: [
        // An existing SSO session. Not a credential — it is the cookie a
        // passkey (or Workspace) login already minted.
        {
          authenticator: "auth-cookie",
          requirement: "ALTERNATIVE",
          priority: 10,
          authenticatorFlow: false,
          userSetupAllowed: false,
        },
        // An explicit kc_idp_hint. ALTERNATIVE, i.e. federation is accepted
        // INSTEAD of a passkey — the trade-off is argued in this file's header.
        {
          authenticator: "identity-provider-redirector",
          requirement: "ALTERNATIVE",
          priority: 20,
          authenticatorFlow: false,
          userSetupAllowed: false,
        },
        // The e-mail domain decides: an Organization domain with a linked
        // provider redirects there, every other address gives way to the
        // passkey sub-flow below.
        {
          flowAlias: PASSKEY_ORGANIZATION_FLOW,
          requirement: "ALTERNATIVE",
          priority: 25,
          authenticatorFlow: true,
          userSetupAllowed: false,
        },
        {
          flowAlias: PASSKEY_FORMS_FLOW,
          requirement: "ALTERNATIVE",
          priority: 30,
          authenticatorFlow: true,
          userSetupAllowed: false,
        },
      ],
    },
    {
      alias: PASSKEY_ORGANIZATION_FLOW,
      description: "Route an e-mail address on an Organization domain to that Organization's identity provider.",
      providerId: "basic-flow",
      topLevel: false,
      builtIn: false,
      authenticationExecutions: [
        {
          flowAlias: PASSKEY_ORGANIZATION_CONDITIONAL_FLOW,
          requirement: "CONDITIONAL",
          priority: 10,
          authenticatorFlow: true,
          userSetupAllowed: false,
        },
      ],
    },
    {
      alias: PASSKEY_ORGANIZATION_CONDITIONAL_FLOW,
      description: "Organization identity-first login, only while the Organizations feature is on for the realm.",
      providerId: "basic-flow",
      topLevel: false,
      builtIn: false,
      authenticationExecutions: [
        {
          authenticator: "conditional-user-configured",
          requirement: "REQUIRED",
          priority: 10,
          authenticatorFlow: false,
          userSetupAllowed: false,
        },
        {
          authenticator: "organization",
          requirement: "ALTERNATIVE",
          priority: 20,
          authenticatorFlow: false,
          userSetupAllowed: false,
        },
      ],
    },
    {
      alias: PASSKEY_FORMS_FLOW,
      description: "Identify the person, then require a passkey. Deliberately contains no password authenticator.",
      providerId: "basic-flow",
      topLevel: false,
      builtIn: false,
      authenticationExecutions: [
        // Username (or e-mail — loginWithEmailAllowed) only. This is
        // `auth-username-form`, NOT `auth-username-password-form`: the
        // latter is the stock browser flow's execution and is the one thing
        // that would put a password box back on the page. It skips its own
        // page when the Organization step above already identified the person.
        {
          authenticator: "auth-username-form",
          requirement: "REQUIRED",
          priority: 10,
          authenticatorFlow: false,
          userSetupAllowed: false,
        },
        // REQUIRED, not ALTERNATIVE: there is nothing to be an alternative
        // TO, and ALTERNATIVE-with-one-execution is how a flow accidentally
        // becomes optional.
        {
          authenticator: WEBAUTHN_PASSWORDLESS_AUTHENTICATOR,
          requirement: "REQUIRED",
          priority: 20,
          authenticatorFlow: false,
          userSetupAllowed: false,
        },
      ],
    },
  ];
}
