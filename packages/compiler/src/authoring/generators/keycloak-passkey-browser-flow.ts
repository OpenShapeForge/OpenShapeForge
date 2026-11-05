// SPDX-License-Identifier: BUSL-1.1
/**
 * Shared passwordless browser flow. Keycloak's username and Organization
 * forms perform native loginless WebAuthn when passkeys are enabled. After
 * identification, the email execution is conditional on no passwordless
 * credential having been verified in this authentication session. A mere
 * identified username never satisfies the condition.
 *
 * Organization identity-first routing and the explicit identity-provider
 * redirect remain alternatives; the tenant identity provider owns its policy.
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
/** The two ways in, as Keycloak alternatives: passkey or e-mail. */
export const PASSKEY_SIGN_IN_FLOW = "passkey-browser-sign-in";

/** OSF provider id of the e-mail code + same-browser link authenticator. */
export const EMAIL_SIGN_IN_AUTHENTICATOR = "osf-email-sign-in";

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
      description: "Offer native passkey sign-in or identify the person for e-mail sign-in.",
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
        // Skip the email challenge only after Keycloak has verified a passkey.
        // With an email address alone, email authentication is still REQUIRED.
        {
          flowAlias: PASSKEY_SIGN_IN_FLOW,
          requirement: "CONDITIONAL",
          priority: 20,
          authenticatorFlow: true,
          userSetupAllowed: false,
        },
      ],
    },
    {
      alias: PASSKEY_SIGN_IN_FLOW,
      description: "Require email sign-in unless a passwordless credential was already verified.",
      providerId: "basic-flow",
      topLevel: false,
      builtIn: false,
      authenticationExecutions: [
        {
          authenticator: "conditional-credential",
          authenticatorConfig: "passkey-not-yet-used",
          requirement: "REQUIRED",
          priority: 10,
          authenticatorFlow: false,
          userSetupAllowed: false,
        },
        {
          authenticator: EMAIL_SIGN_IN_AUTHENTICATOR,
          requirement: "REQUIRED",
          priority: 20,
          authenticatorFlow: false,
          userSetupAllowed: false,
        },
      ],
    },
  ];
}
