// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  PASSKEY_BROWSER_FLOW,
  PASSKEY_DIRECT_GRANT_FLOW,
  PASSKEY_REGISTRATION_FLOW,
  WEBAUTHN_PASSWORDLESS_REQUIRED_ACTION,
  buildPasskeyProfile,
  resolvePasskeyRpId,
} from "./keycloak-passkeys.js";
import { generateKeycloakRealmArtifacts } from "./keycloak.js";
import type { AuthorizationConfigFile } from "../types/authoring.js";

const profile = (over: Partial<Parameters<typeof buildPasskeyProfile>[0]> = {}) =>
  buildPasskeyProfile({ realmName: "acme", rpId: "acme.example", dev: false, ...over });

/** Every authenticator provider id reachable from the browser flow, sub-flows included. */
function browserFlowAuthenticators(p: ReturnType<typeof profile>): string[] {
  const byAlias = new Map(p.authenticationFlows.map((f) => [f.alias, f]));
  const out: string[] = [];
  const walk = (alias: string, seen = new Set<string>()) => {
    if (seen.has(alias)) return;
    seen.add(alias);
    for (const e of byAlias.get(alias)?.authenticationExecutions ?? []) {
      if (e.authenticator) out.push(e.authenticator);
      if (e.flowAlias) walk(e.flowAlias, seen);
    }
  };
  walk(p.browserFlow);
  return out;
}

describe("passkey profile — no password path for a human", () => {
  it("puts no password authenticator anywhere in the browser flow", () => {
    const reachable = browserFlowAuthenticators(profile());
    expect(reachable).toContain("webauthn-authenticator-passwordless");
    expect(reachable).toContain("auth-username-form");
    // The one execution that would put a password box back on the page.
    expect(reachable).not.toContain("auth-username-password-form");
    expect(reachable.filter((a) => a.includes("password") && !a.includes("passwordless"))).toEqual([]);
  });

  it("closes the direct grant with deny-access rather than relying on nobody having a password", () => {
    const p = profile();
    expect(p.directGrantFlow).toBe(PASSKEY_DIRECT_GRANT_FLOW);
    const flow = p.authenticationFlows.find((f) => f.alias === PASSKEY_DIRECT_GRANT_FLOW);
    expect(flow?.authenticationExecutions.map((e) => e.authenticator)).toEqual([
      "deny-access-authenticator",
    ]);
  });

  it("keeps the federated identity provider as an alternative to a passkey", () => {
    const top = profile().authenticationFlows.find((f) => f.alias === PASSKEY_BROWSER_FLOW);
    const idp = top?.authenticationExecutions.find(
      (e) => e.authenticator === "identity-provider-redirector",
    );
    // ALTERNATIVE, i.e. a Workspace login admits the person on its own. This
    // assertion exists so that flipping it to REQUIRED — which would silently
    // change what every federated tenant experiences — has to be deliberate.
    expect(idp?.requirement).toBe("ALTERNATIVE");
  });
});

describe("passkey profile — required actions", () => {
  const byAlias = Object.fromEntries(profile().requiredActions.map((a) => [a.alias, a]));

  it("walks a person with no passkey through enrolling one", () => {
    expect(byAlias[WEBAUTHN_PASSWORDLESS_REQUIRED_ACTION]).toMatchObject({
      enabled: true,
      defaultAction: true,
    });
  });

  it("switches off the actions that would hand somebody a credential this realm cannot accept", () => {
    expect(byAlias.UPDATE_PASSWORD).toMatchObject({ enabled: false });
    // Second-factor WebAuthn registration: looks like passkey enrolment, produces
    // a credential the passwordless authenticator refuses.
    expect(byAlias["webauthn-register"]).toMatchObject({ enabled: false });
    expect(byAlias.CONFIGURE_TOTP).toMatchObject({ enabled: false });
    expect(byAlias.CONFIGURE_RECOVERY_AUTHN_CODES).toMatchObject({ enabled: false });
  });

  it("is the COMPLETE registry, because a realm import replaces the list wholesale", () => {
    for (const alias of [
      "VERIFY_EMAIL",
      "VERIFY_PROFILE",
      "UPDATE_PROFILE",
      "delete_credential",
      "idp_link",
      "update_user_locale",
      "TERMS_AND_CONDITIONS",
      "delete_account",
      "UPDATE_EMAIL",
    ]) {
      expect(byAlias[alias]).toBeDefined();
    }
  });
});

describe("passkey profile — an invited person creates an account without a password", () => {
  /** Every provider id reachable from the registration flow, sub-flows included. */
  const registrationAuthenticators = () => {
    const p = profile();
    const byAlias = new Map(p.authenticationFlows.map((f) => [f.alias, f]));
    const out: string[] = [];
    const walk = (alias: string, seen = new Set<string>()) => {
      if (seen.has(alias)) return;
      seen.add(alias);
      for (const e of byAlias.get(alias)?.authenticationExecutions ?? []) {
        if (e.authenticator) out.push(e.authenticator);
        if (e.flowAlias) walk(e.flowAlias, seen);
      }
    };
    walk(p.registrationFlow);
    return out;
  };

  it("owns the registration flow instead of leaving Keycloak's stock one in place", () => {
    // The stock flow is the one that put a password box on the Organization
    // invitation page: closing `registrationAllowed` never reached it, because
    // an invitation admits the invitee whatever that flag says.
    expect(profile().registrationFlow).toBe(PASSKEY_REGISTRATION_FLOW);
  });

  it("creates the account with no credential and no password execution", () => {
    const reachable = registrationAuthenticators();
    expect(reachable).toContain("registration-page-form");
    expect(reachable).toContain("registration-user-creation");
    expect(reachable).not.toContain("registration-password-action");
    expect(reachable.filter((a) => a.includes("password") && !a.includes("passwordless"))).toEqual([]);
  });

  it("leaves the passkey to the default required action, which is the only supported shape", () => {
    // Keycloak 26.5.3 ships no registration-time WebAuthn form action
    // (measured: /authentication/form-action-providers lists five, none of
    // them WebAuthn), so enrolment has to be the required action — and it has
    // to be a DEFAULT one, or the account would exist with no way in at all.
    const action = profile().requiredActions.find((a) => a.alias === WEBAUTHN_PASSWORDLESS_REQUIRED_ACTION);
    expect(action?.enabled).toBe(true);
    expect(action?.defaultAction).toBe(true);
  });
});

describe("passkey profile — the WebAuthn policy is a decision, not a default", () => {
  const p = profile({ realmDisplayName: "Acme B.V." });

  it("pins the values that make it a passkey", () => {
    expect(p.webAuthnPolicyPasswordlessRequireResidentKey).toBe("Yes");
    expect(p.webAuthnPolicyPasswordlessUserVerificationRequirement).toBe("required");
    expect(p.webAuthnPolicyPasswordlessSignatureAlgorithms).toEqual(["ES256", "RS256"]);
    expect(p.webAuthnPolicyPasswordlessRpEntityName).toBe("Acme B.V.");
    expect(p.webAuthnPolicyPasswordlessCreateTimeout).toBe(120);
  });

  it("leaves the two settings the escape hatches depend on wide open", () => {
    // "platform" here would switch off the QR / cross-device route AND roaming
    // security keys — the answer for a machine with no biometrics.
    expect(p.webAuthnPolicyPasswordlessAuthenticatorAttachment).toBe("not specified");
    // An AAGUID allow-list is a hardware allow-list.
    expect(p.webAuthnPolicyPasswordlessAcceptableAaguids).toEqual([]);
  });
});

describe("resolvePasskeyRpId", () => {
  it("refuses to guess for a production realm", () => {
    expect(() => resolvePasskeyRpId(undefined, false, "acme")).toThrow(
      /realm\.webAuthn\.rpId is required/,
    );
  });

  it("falls back to localhost only for a development realm", () => {
    expect(resolvePasskeyRpId(undefined, true, "acme")).toBe("localhost");
  });

  it("rejects a URL, which is the classic WebAuthn misconfiguration", () => {
    expect(() => resolvePasskeyRpId("https://auth.acme.example:8443/", false, "acme")).toThrow(
      /not a bare hostname/,
    );
  });

  it("accepts a bare hostname", () => {
    expect(resolvePasskeyRpId("acme.example", false, "acme")).toBe("acme.example");
  });
});

describe("the profile reaches the generated realm export, in every mode", () => {
  const authConfig = {
    schemaVersion: 2,
    kind: "authorizationConfig",
    realm: { name: "acme", displayName: "Acme", webAuthn: { rpId: "acme.example" } },
    keycloak: { entityRoleClient: "acme-api", clients: [{ id: "acme-api", kind: "bearerOnly" }] },
  } as unknown as AuthorizationConfigFile;

  for (const mode of ["development", "production"] as const) {
    it(`emits the passkey browser flow in ${mode} mode`, () => {
      const [artifact] = generateKeycloakRealmArtifacts([], authConfig, mode);
      const realm = JSON.parse(artifact.contents);
      // The whole point of the seam: no mode, no env var and no authoring key
      // turns the password flow back on in the artifact.
      expect(realm.browserFlow).toBe(PASSKEY_BROWSER_FLOW);
      expect(realm.directGrantFlow).toBe(PASSKEY_DIRECT_GRANT_FLOW);
      expect(realm.registrationFlow).toBe(PASSKEY_REGISTRATION_FLOW);
      expect(
        realm.authenticationFlows.flatMap((f: { authenticationExecutions: { authenticator?: string }[] }) =>
          f.authenticationExecutions.map((e) => e.authenticator),
        ),
      ).not.toContain("registration-password-action");
      expect(realm.webAuthnPolicyPasswordlessRpId).toBe("acme.example");
      expect(realm.resetPasswordAllowed).toBe(false);
      expect(JSON.stringify(realm.authenticationFlows)).not.toContain("auth-username-password-form");
    });
  }

  it("still refuses a production realm that authored no rpId", () => {
    const noRpId = JSON.parse(JSON.stringify(authConfig));
    delete noRpId.realm.webAuthn;
    expect(() => generateKeycloakRealmArtifacts([], noRpId, "production")).toThrow(
      /realm\.webAuthn\.rpId is required/,
    );
  });

  it("will not substitute a committed rpId fallback for a production realm", () => {
    const envRef = JSON.parse(JSON.stringify(authConfig));
    envRef.realm.webAuthn.rpId = "${env:PASSKEY_RP_ID_TEST_UNSET:-dev.example}";
    expect(generateKeycloakRealmArtifacts([], envRef, "development")).toHaveLength(1);
    expect(() => generateKeycloakRealmArtifacts([], envRef, "production")).toThrow(
      /PASSKEY_RP_ID_TEST_UNSET is not set/,
    );
  });
});
