// SPDX-License-Identifier: BUSL-1.1
/**
 * The required-action registry of the passkey profile.
 *
 * Split out of keycloak-passkeys.ts only for size — every decision below is
 * part of the same profile and the reasoning that frames it lives in that
 * file's header. The list is the COMPLETE registry, not a patch: a realm
 * import REPLACES it wholesale (measured on 26.5.3), so every action Keycloak
 * ships is named here with a deliberate value.
 */

/** Keycloak's provider id for the passkey enrolment required action. */
export const WEBAUTHN_PASSWORDLESS_REQUIRED_ACTION = "webauthn-register-passwordless";

export interface KeycloakRequiredActionExport {
  alias: string;
  name: string;
  providerId: string;
  enabled: boolean;
  defaultAction: boolean;
  priority: number;
  config: Record<string, string>;
}

export const PASSKEY_REQUIRED_ACTIONS: KeycloakRequiredActionExport[] = [
    {
      // Off. TOTP is a second factor and this browser flow has no OTP
      // execution to consume one, so leaving it on only lets a person enrol
      // a credential that can never be presented.
      alias: "CONFIGURE_TOTP",
      name: "Configure OTP",
      providerId: "CONFIGURE_TOTP",
      enabled: false,
      defaultAction: false,
      priority: 10,
      config: {},
    },
    { alias: "TERMS_AND_CONDITIONS", name: "Terms and Conditions", providerId: "TERMS_AND_CONDITIONS", enabled: false, defaultAction: false, priority: 20, config: {} },
    {
      // Explicitly off rather than merely unused: with this enabled an
      // administrator could push "update password" onto a person and hand
      // them a credential the browser flow will never accept — a dead end
      // that looks like a recovery route. The recovery route is the
      // enrolment link described in this file's header.
      alias: "UPDATE_PASSWORD",
      name: "Update Password",
      providerId: "UPDATE_PASSWORD",
      enabled: false,
      defaultAction: false,
      priority: 30,
      config: {},
    },
    { alias: "UPDATE_PROFILE", name: "Update Profile", providerId: "UPDATE_PROFILE", enabled: true, defaultAction: false, priority: 40, config: {} },
    {
      // On, and load-bearing: the escape-hatch enrolment link is delivered
      // by e-mail, so a verified address is what the whole recovery story
      // rests on.
      alias: "VERIFY_EMAIL",
      name: "Verify Email",
      providerId: "VERIFY_EMAIL",
      enabled: true,
      defaultAction: false,
      priority: 50,
      config: {},
    },
    { alias: "delete_account", name: "Delete Account", providerId: "delete_account", enabled: false, defaultAction: false, priority: 60, config: {} },
    { alias: "UPDATE_EMAIL", name: "Update Email", providerId: "UPDATE_EMAIL", enabled: false, defaultAction: false, priority: 70, config: {} },
    {
      // Off — and this one is a trap worth naming. `webauthn-register` is
      // the SECOND-FACTOR registration: it enrols a credential under the
      // non-passwordless policy, which does not require a resident key. It
      // looks exactly like enrolling a passkey and produces a credential
      // `webauthn-authenticator-passwordless` will refuse.
      alias: "webauthn-register",
      name: "Webauthn Register",
      providerId: "webauthn-register",
      enabled: false,
      defaultAction: false,
      priority: 80,
      config: {},
    },
    {
      // defaultAction: every new user carries it, so somebody who arrives
      // over Google Workspace, or through an admin-issued enrolment link,
      // is walked through creating a passkey and leaves with one.
      alias: WEBAUTHN_PASSWORDLESS_REQUIRED_ACTION,
      name: "Webauthn Register Passwordless",
      providerId: WEBAUTHN_PASSWORDLESS_REQUIRED_ACTION,
      enabled: true,
      defaultAction: true,
      priority: 90,
      config: {},
    },
    { alias: "VERIFY_PROFILE", name: "Verify Profile", providerId: "VERIFY_PROFILE", enabled: true, defaultAction: false, priority: 100, config: {} },
    {
      // On. Somebody whose phone was lost has to be able to remove that
      // passkey from the account console once they are back in on another
      // one.
      alias: "delete_credential",
      name: "Delete Credential",
      providerId: "delete_credential",
      enabled: true,
      defaultAction: false,
      priority: 110,
      config: {},
    },
    { alias: "idp_link", name: "Linking Identity Provider", providerId: "idp_link", enabled: true, defaultAction: false, priority: 120, config: {} },
    {
      // Off. Recovery codes are only a recovery route if some execution
      // accepts them, and this browser flow has none. Enabling it would
      // hand people a printed sheet that does not open the door. The
      // recovery route is the admin-issued enrolment link.
      alias: "CONFIGURE_RECOVERY_AUTHN_CODES",
      name: "Recovery Authentication Codes",
      providerId: "CONFIGURE_RECOVERY_AUTHN_CODES",
      enabled: false,
      defaultAction: false,
      priority: 130,
      config: {},
    },
    { alias: "update_user_locale", name: "Update User Locale", providerId: "update_user_locale", enabled: true, defaultAction: false, priority: 1000, config: {} },
];
