// SPDX-License-Identifier: BUSL-1.1
/**
 * The passkey profile every generated realm carries.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A HUMAN signs in with a passkey (WebAuthn, resident credential, user
 * verification required). There is no password execution anywhere in the
 * browser flow, none in the REGISTRATION flow an invited person meets either,
 * and the direct-grant (Resource Owner Password Credentials) flow is wired to
 * an authenticator that always denies, so there is no second door. Client
 * secrets are untouched: a confidential client or a service account is not a
 * human and keeps using client_credentials.
 *
 * ── Why this file has no development mode ───────────────────────────────────
 * `resolveRealmMode()` exists in keycloak.ts and DEFAULTS TO DEVELOPMENT, for
 * a good reason: `bun run generate` runs constantly, and for a *secret* the
 * safe failure is the fake one. For an authentication FLOW the safe failure is
 * the opposite way round — a forgotten `OPENSHAPEFORGE_REALM_MODE=production`
 * would publish a realm that accepts passwords. So the mode is deliberately
 * NOT an input here. Everything below is emitted for every authored realm,
 * every time.
 *
 * The development relaxation is therefore not a flag in this compiler at all.
 * It lives in `scripts/keycloak/kc-dev-password-login.py`, which mutates a
 * RUNNING Keycloak over its admin API, refuses to talk to anything but
 * loopback, and produces no artifact. Nothing it does can be committed,
 * imported by `--import-realm`, or handed to Helm. The unsafe direction costs
 * somebody a deliberate command on their own laptop; the safe direction is
 * what falls out of the build.
 *
 * ── Somebody whose device cannot do a passkey ───────────────────────────────
 * Three routes, in the order support should offer them. All three are real
 * configuration below, not aspiration.
 *
 *  1. CROSS-DEVICE PASSKEY (the answer for most cases, including "this laptop
 *     has no fingerprint reader"). The login page shows a QR code; the person
 *     scans it with a phone that has a passkey, and the phone signs over the
 *     CTAP2 hybrid transport. This works only because
 *     `webAuthnPolicyPasswordlessAuthenticatorAttachment` is left at
 *     "not specified" below — pinning it to "platform" would switch the QR
 *     option off and is the single most common way to break this.
 *  2. ROAMING SECURITY KEY (USB/NFC). A YubiKey-class key enrols and signs on
 *     any machine. Enabled by the same "not specified" attachment plus an
 *     empty `acceptableAaguids` — an AAGUID allow-list would exclude most
 *     keys and every phone.
 *  3. ADMIN-ISSUED ENROLMENT LINK, for somebody with neither: no passkey yet,
 *     and no device that can make one on the machine in front of them. A realm
 *     administrator (`realm-management` `manage-users`; in this codebase that
 *     is the `openshapeforge-auth-api` service account, i.e. the same
 *     privilege the employee invitation already runs on) calls
 *
 *         PUT /admin/realms/<realm>/users/<id>/execute-actions-email
 *             ?lifespan=<seconds>
 *         ["webauthn-register-passwordless"]
 *
 *     Keycloak e-mails a Keycloak action token. It is SINGLE USE (the token
 *     id is recorded once redeemed) and TIME BOXED — pass `lifespan`
 *     explicitly; the realm default is
 *     `actionTokenGeneratedByAdminLifespan`, 12 hours. Redeeming it drops the
 *     person straight into passkey enrolment with no password anywhere in the
 *     path. Nobody can trigger it for themselves: `resetPasswordAllowed` is
 *     forced off below, so there is no self-service "e-mail me a link" form.
 *     An administrator has to do it, and it is written to the admin event log.
 *
 * ── Google Workspace ────────────────────────────────────────────────────────
 * `google-workspace` is the one linked identity provider, and it IS an
 * accepted alternative to presenting a passkey — the `identity-provider-
 * redirector` execution sits at ALTERNATIVE next to the passkey sub-flow, so
 * whichever one answers first admits the person.
 *
 * That is a decision, not an oversight, and it cuts both ways:
 *   - FOR: the provider is linked per Keycloak Organization to one tenant's
 *     own Workspace domain (see control/keycloak-organization-admin.ts). For
 *     that tenant, Google IS the identity authority, and their own Workspace
 *     MFA policy is what actually guards the account. Demanding a second,
 *     Hubble-specific passkey on top makes the SSO the tenant bought
 *     pointless and doubles their enrolment burden.
 *   - AGAINST, stated plainly: it means the passkey-only guarantee is only as
 *     strong as that tenant's Workspace policy. A Workspace that still allows
 *     bare passwords re-opens a password path into Hubble — at Google, not
 *     here. That is the tenant's risk to carry, and it is the price of
 *     federating at all.
 * Two things keep it from being a hole by accident: `hideOnLogin: true` (the
 * button is not on the realm login page; only a member of an Organization
 * that linked the provider is routed to it), and the
 * `webauthn-register-passwordless` required action being a DEFAULT action, so
 * a person who arrives over Workspace is walked through enrolling a passkey
 * anyway and ends up with one.
 */

import { PASSKEY_REQUIRED_ACTIONS } from "./keycloak-passkey-required-actions.js";
import type { KeycloakRequiredActionExport } from "./keycloak-passkey-required-actions.js";
export { WEBAUTHN_PASSWORDLESS_REQUIRED_ACTION } from "./keycloak-passkey-required-actions.js";
export type { KeycloakRequiredActionExport };

/** Top-level browser flow alias. */
export const PASSKEY_BROWSER_FLOW = "passkey-browser";
/** Sub-flow holding the actual credential challenge. */
const PASSKEY_FORMS_FLOW = "passkey-browser-forms";
/** Top-level direct-grant flow alias — the one that always denies. */
export const PASSKEY_DIRECT_GRANT_FLOW = "passkey-direct-grant-denied";
/** Top-level registration flow alias — account creation without a password. */
export const PASSKEY_REGISTRATION_FLOW = "passkey-registration";
/** The form sub-flow the registration page renders. */
const PASSKEY_REGISTRATION_FORM = "passkey-registration-form";

/** Keycloak's provider id for the passwordless (passkey) authenticator. */
const WEBAUTHN_PASSWORDLESS_AUTHENTICATOR = "webauthn-authenticator-passwordless";

export interface KeycloakAuthenticationExecutionExport {
  authenticator?: string;
  flowAlias?: string;
  requirement: "REQUIRED" | "ALTERNATIVE" | "CONDITIONAL" | "DISABLED";
  priority: number;
  authenticatorFlow: boolean;
  userSetupAllowed: boolean;
  autheticatorFlow?: boolean;
}

export interface KeycloakAuthenticationFlowExport {
  alias: string;
  description: string;
  providerId: "basic-flow" | "form-flow";
  topLevel: boolean;
  builtIn: boolean;
  authenticationExecutions: KeycloakAuthenticationExecutionExport[];
}

export interface PasskeyProfile {
  browserFlow: string;
  directGrantFlow: string;
  registrationFlow: string;
  authenticationFlows: KeycloakAuthenticationFlowExport[];
  requiredActions: KeycloakRequiredActionExport[];
  webAuthnPolicyPasswordlessRpEntityName: string;
  webAuthnPolicyPasswordlessRpId: string;
  webAuthnPolicyPasswordlessSignatureAlgorithms: string[];
  webAuthnPolicyPasswordlessAttestationConveyancePreference: string;
  webAuthnPolicyPasswordlessAuthenticatorAttachment: string;
  webAuthnPolicyPasswordlessRequireResidentKey: string;
  webAuthnPolicyPasswordlessUserVerificationRequirement: string;
  webAuthnPolicyPasswordlessCreateTimeout: number;
  webAuthnPolicyPasswordlessAvoidSameAuthenticatorRegister: boolean;
  webAuthnPolicyPasswordlessAcceptableAaguids: string[];
  webAuthnPolicyPasswordlessExtraOrigins: string[];
}

/**
 * A WebAuthn Relying Party ID is a BARE HOSTNAME — never a URL, never a port.
 * Getting this wrong is the classic WebAuthn misconfiguration and the browser
 * reports it as an opaque `SecurityError`, so it is rejected here instead.
 */
const RP_ID_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * Resolve the relying-party id.
 *
 * It CANNOT be derived from the gateway's `redirectUris`: the WebAuthn
 * ceremony runs on Keycloak's OWN login page, so the rpId has to match
 * Keycloak's browser-facing hostname (or a registrable parent shared with the
 * app — e.g. `hubble.localhost` covering both `auth.hubble.localhost` and
 * `app.hubble.localhost`). The compiler has no way to know that host, so it is
 * authored, and a production realm that did not author it fails generation
 * rather than shipping a guess.
 */
export function resolvePasskeyRpId(
  authored: string | undefined,
  dev: boolean,
  realmName: string,
): string {
  const raw = authored?.trim();
  if (!raw) {
    if (!dev) {
      throw new Error(
        `Realm "${realmName}": realm.webAuthn.rpId is required. It is the WebAuthn relying-party id and must be ` +
          "Keycloak's browser-facing hostname, or a registrable parent domain shared by Keycloak and the app " +
          '(e.g. rpId "example.com" for a login page on "auth.example.com"). It cannot be inferred from the ' +
          "gateway redirectUris, because the passkey ceremony runs on Keycloak's own login page, not the app's.",
      );
    }
    // Development only: the local login page is served from a loopback name,
    // and the browser flow is relaxed to passwords there anyway (see
    // scripts/keycloak/kc-dev-password-login.py), so this value is never
    // exercised on a laptop.
    return "localhost";
  }
  if (!RP_ID_RE.test(raw)) {
    throw new Error(
      `Realm "${realmName}": realm.webAuthn.rpId "${raw}" is not a bare hostname. ` +
        "A WebAuthn relying-party id carries no scheme, no port and no path — write \"example.com\", " +
        'not "https://example.com:8443/".',
    );
  }
  return raw;
}

/**
 * Build the passkey profile for one realm.
 *
 * `dev` only ever affects the rpId FALLBACK (a value that is unused on a
 * laptop). It does not, and must not, reach any flow, execution or required
 * action below.
 */
export function buildPasskeyProfile(options: {
  realmName: string;
  realmDisplayName?: string;
  rpId?: string;
  dev: boolean;
}): PasskeyProfile {
  const { realmName, realmDisplayName, rpId, dev } = options;

  return {
    browserFlow: PASSKEY_BROWSER_FLOW,
    directGrantFlow: PASSKEY_DIRECT_GRANT_FLOW,
    registrationFlow: PASSKEY_REGISTRATION_FLOW,
    authenticationFlows: [
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
          // Google Workspace, reached by kc_idp_hint or an Organization link.
          // ALTERNATIVE, i.e. federation is accepted INSTEAD of a passkey —
          // the trade-off is argued in this file's header.
          {
            authenticator: "identity-provider-redirector",
            requirement: "ALTERNATIVE",
            priority: 20,
            authenticatorFlow: false,
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
        alias: PASSKEY_FORMS_FLOW,
        description: "Identify the person, then require a passkey. Deliberately contains no password authenticator.",
        providerId: "basic-flow",
        topLevel: false,
        builtIn: false,
        authenticationExecutions: [
          // Username (or e-mail — loginWithEmailAllowed) only. This is
          // `auth-username-form`, NOT `auth-username-password-form`: the
          // latter is the stock browser flow's execution and is the one thing
          // that would put a password box back on the page.
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
      {
        // ── Account creation ────────────────────────────────────────────────
        // `registrationAllowed` is off, so nobody reaches this by browsing to
        // the login page and clicking "register": the only door is a Keycloak
        // Organization INVITATION, which admits the invitee to the
        // registration flow whatever `registrationAllowed` says (measured on
        // 26.5.3 — that is exactly why closing the realm flag was not enough).
        // What is closed here is the OTHER half. Keycloak's stock
        // `registration` flow contains `registration-password-action`, so an
        // invited person was handed a form asking for a username AND A
        // PASSWORD — a credential the browser flow above will never accept.
        // This flow is the stock one with that execution simply absent, and
        // nothing replaces it: the account is created with no credential, and
        // the `webauthn-register-passwordless` DEFAULT required action (see
        // keycloak-passkey-required-actions.ts) is what the person meets next,
        // in the same session, before any token is issued. Keycloak 26.5.3 has
        // no registration-time WebAuthn form action — the required action IS
        // the supported shape.
        alias: PASSKEY_REGISTRATION_FLOW,
        description: "Account creation for an invited person. Contains no password execution.",
        providerId: "basic-flow",
        topLevel: true,
        builtIn: false,
        authenticationExecutions: [
          {
            authenticator: "registration-page-form",
            flowAlias: PASSKEY_REGISTRATION_FORM,
            requirement: "REQUIRED",
            priority: 10,
            authenticatorFlow: true,
            autheticatorFlow: true,
            userSetupAllowed: false,
          },
        ],
      },
      {
        alias: PASSKEY_REGISTRATION_FORM,
        description: "Profile fields only. `registration-password-action` is absent on purpose.",
        providerId: "form-flow",
        topLevel: false,
        builtIn: false,
        authenticationExecutions: [
          {
            authenticator: "registration-user-creation",
            requirement: "REQUIRED",
            priority: 20,
            authenticatorFlow: false,
            userSetupAllowed: false,
          },
        ],
      },
      {
        // The Resource Owner Password Credentials grant. Leaving Keycloak's
        // stock `direct grant` flow in place would mean a human with a
        // leftover password credential could still POST
        // grant_type=password and get a token, bypassing every decision above
        // — a real hole, not a theoretical one. `deny-access-authenticator`
        // closes it at the realm, so it does not depend on no user happening
        // to have a password. Service accounts are unaffected:
        // client_credentials does not run this flow.
        alias: PASSKEY_DIRECT_GRANT_FLOW,
        description: "Direct grant (grant_type=password) is closed for this realm. Humans use passkeys.",
        providerId: "basic-flow",
        topLevel: true,
        builtIn: false,
        authenticationExecutions: [
          {
            authenticator: "deny-access-authenticator",
            requirement: "REQUIRED",
            priority: 10,
            authenticatorFlow: false,
            userSetupAllowed: false,
          },
        ],
      },
    ],
    requiredActions: PASSKEY_REQUIRED_ACTIONS,
    // The name a browser shows in the system passkey prompt ("Sign in to
    // ..."). Left at Keycloak's shipped "keycloak" it would read as somebody
    // else's product.
    webAuthnPolicyPasswordlessRpEntityName: realmDisplayName?.trim() || realmName,
    webAuthnPolicyPasswordlessRpId: resolvePasskeyRpId(rpId, dev, realmName),
    // ES256 covers Apple, Android and every FIDO2 key; RS256 covers Windows
    // Hello's TPM-backed credentials. RS1 (SHA-1) is deliberately absent.
    webAuthnPolicyPasswordlessSignatureAlgorithms: ["ES256", "RS256"],
    // We do not verify attestation statements, so asking for one only adds a
    // browser consent prompt and hands us an authenticator fingerprint we
    // have no policy for. "none" is the honest setting.
    webAuthnPolicyPasswordlessAttestationConveyancePreference: "none",
    // MUST stay unspecified. "platform" would restrict enrolment to the
    // machine's own authenticator and switch off both escape hatches: the
    // cross-device QR flow and roaming security keys.
    webAuthnPolicyPasswordlessAuthenticatorAttachment: "not specified",
    // A discoverable (resident) credential is what makes this a passkey
    // rather than a second factor: the credential carries the user handle, so
    // the authenticator can answer without the server first proving who is
    // asking.
    webAuthnPolicyPasswordlessRequireResidentKey: "Yes",
    // The passkey is the ONLY factor, so the authenticator has to establish
    // that the right person is present — biometric or PIN. "preferred" would
    // silently degrade to mere presence on some authenticators.
    webAuthnPolicyPasswordlessUserVerificationRequirement: "required",
    // Seconds. Keycloak's default 0 means "no timeout", which leaves a hung
    // ceremony on screen forever. 120s is enough to unlock a phone and scan a
    // QR code, which is the slowest path we support on purpose.
    webAuthnPolicyPasswordlessCreateTimeout: 120,
    // Enrolling a second passkey should give the person a second DEVICE (the
    // recovery story), not a duplicate on the one they are holding.
    webAuthnPolicyPasswordlessAvoidSameAuthenticatorRegister: true,
    // Empty on purpose: an AAGUID allow-list is a hardware allow-list, and it
    // would exclude phone passkeys and most security keys — the two escape
    // hatches this profile depends on.
    webAuthnPolicyPasswordlessAcceptableAaguids: [],
    // No extra origins. Every ceremony runs on Keycloak's own login page.
    webAuthnPolicyPasswordlessExtraOrigins: [],
  };
}
