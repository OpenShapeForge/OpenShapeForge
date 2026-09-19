# External identity providers

OpenShapeForge's Keycloak layer can broker logins to external identity
providers: public social providers (Google, Microsoft, GitHub, Apple) and a
customer's own corporate OIDC or SAML issuer. This page separates three things
that are easy to blur:

1. **What OSF ships** — provider *implementations* and a provider-agnostic
   authoring contract. Never a provider.
2. **What a host authors** — which providers exist in a realm, and every ID,
   URL, scope, secret reference and mapper they carry. The host's values are
   final; OSF emits them unchanged.
3. **How a running realm picks the change up** — `--import-realm` is for fresh
   realms; an existing realm needs reconciliation.

No provider is enabled by default. The two realms authored in this repository
(`authorization.yaml`, `authorization.control.yaml`) author none, and the
generator emits no `identityProviders` key at all for a realm that stays quiet.

## 1. What OSF ships

| Piece | Where | Notes |
| --- | --- | --- |
| Keycloak's built-in providers (`google`, `microsoft`, `github`, `oidc`, `saml`, …) | Keycloak base image | Nothing to install. |
| Apple Sign-in provider (`apple`) | `packages/keycloak-spi/Dockerfile` | Third-party jar, version and SHA-512 pinned; see [supply chain](#supply-chain-keycloak--provider-lockstep). |
| The `keycloak.identityProviders` authoring contract | `packages/compiler/src/authoring/types/authoring.ts` | Emitted by `generators/keycloak.ts` into each realm's `identityProviders` and `identityProviderMappers`. |

Provider code lives in the OSF Keycloak image and nowhere else — not in a host
product and not in a domain plugin. Tenant-supplied jars or dynamic code loading
are not supported and not planned.

## 2. What a host authors

Add `identityProviders` under `keycloak:` in the realm's `authorizationConfig`
document. One entry per provider:

```yaml
keycloak:
  identityProviders:
    - alias: customer-workforce          # realm-unique; the login-URL segment
      providerId: oidc                   # google | microsoft | github | apple | oidc | saml | <approved custom id>
      displayName: Continue with company account
      enabled: true                      # default true
      trustEmail: false                  # default false
      storeToken: false                  # default false
      linkOnly: false                    # default false
      hideOnLogin: false                 # default false
      firstBrokerLoginFlowAlias: first broker login
      config:                            # non-secret Keycloak provider config, emitted unchanged
        clientId: customer-workforce
        issuer: https://identity.customer.example
        authorizationUrl: https://identity.customer.example/oauth2/authorize
        tokenUrl: https://identity.customer.example/oauth2/token
        jwksUrl: https://identity.customer.example/.well-known/jwks.json
        useJwksUrl: true
        defaultScope: openid profile email
      secrets:                           # sensitive keys; ${env:VAR} in production
        clientSecret: ${env:KEYCLOAK_IDP_CUSTOMER_WORKFORCE_CLIENT_SECRET}
      devSecrets:                        # development only; refused in production
        clientSecret: dev-only-secret
      mappers:
        - name: department
          identityProviderMapper: oidc-user-attribute-idp-mapper
          config:
            claim: dept
            user.attribute: department
            syncMode: FORCE
```

`config`, `secrets` and `devSecrets` are merged into the provider's Keycloak
`config` map. Mappers are flattened into the realm's `identityProviderMappers`
list, each bound to its provider's alias.

**The authored entry is the final value.** The generator does not supply
endpoint defaults for a built-in, rename an alias, add a mapper, or enable
anything. A host that wants Google authors `providerId: google` with its own
client ID; a host whose customers must not touch a public provider authors
`providerId: oidc` or `saml` with the customer's own endpoints instead; a host
can replace the entire set without touching OSF source.

Only these transformations are applied to a value:

- YAML booleans and numbers become the strings Keycloak's representation
  requires (`useJwksUrl: true` → `"true"`).
- `${env:VAR}` / `${env:VAR:-fallback}` references are resolved at generate
  time, under the same rules as client secrets (the fallback is
  development-only). This applies to provider `config` and to every mapper's
  `config` alike, so a parameterised role or attribute mapper never imports a
  literal placeholder.

### Built-in providers

Same contract, different `providerId`. Keycloak knows Google's, Microsoft's and
GitHub's endpoints itself, so `config` typically carries only `clientId` and
`defaultScope`:

```yaml
    - alias: google
      providerId: google
      displayName: Continue with Google
      config:
        clientId: 1234567890-example.apps.googleusercontent.com
        defaultScope: openid email profile
      secrets:
        clientSecret: ${env:KEYCLOAK_IDP_GOOGLE_CLIENT_SECRET}
```

### Apple

Sign in with Apple uses the bundled provider (`providerId: apple`). Apple does
not use a static client secret: the provider signs an expiring client JWT with
the `.p8` private key of a Sign in with Apple key, so the key content is the
secret.

```yaml
    - alias: apple
      providerId: apple
      displayName: Continue with Apple
      config:
        clientId: com.example.web          # the Service ID (web), not the App ID
        teamId: TEAMID1234
        keyId: KEYID12345
        defaultScope: name email
        tokenExchangeAccountLinkingEnabled: false
      secrets:
        clientSecret: ${env:KEYCLOAK_IDP_APPLE_P8_KEY}   # raw .p8 content
```

- **Redirect URI** to register on the Service ID:
  `https://<keycloak-host>/realms/<realm>/broker/<alias>/endpoint`. Apple
  requires https and a registered domain; `localhost` is not accepted, so local
  work needs a tunnel or a dev-only Service ID on a real hostname.
- **Private email relay.** A user may hand Apple's `@privaterelay.appleid.com`
  address instead of a real one. Treat it as an opaque, stable identifier for
  that user–app pair: do not use it to match an existing account, and expect
  outbound mail to it to work only from senders registered in Apple's relay
  configuration.
- **Name and email arrive once.** Apple sends them only on the first
  authorization. The provider persists them at first broker login; a later login
  carries only the stable subject.
- `tokenExchangeAccountLinkingEnabled: false` is **required**, not merely
  recommended: for `providerId: apple` the generator refuses `true` and
  refuses an absent flag. With it on, the provider would link an incoming
  Apple identity to an existing account by e-mail on token exchange, which is
  exactly the silent linking ruled out below. Native token exchange stays out
  of scope.
- Never commit the `.p8` file or a generated JWT. Store the key content in the
  secret store that feeds `KEYCLOAK_IDP_APPLE_P8_KEY` at generate/deploy time.
  **Rotating the key**: create a new key in the Apple developer portal, update
  `config.keyId` and the secret together, regenerate, reconcile, then revoke
  the old key.

### Validation — what can reject an entry

Everything a host writes is preserved; only unsafe entries fail generation.

| Rule | Mode |
| --- | --- |
| Aliases unique per realm; alias, `providerId`, mapper `name` and `identityProviderMapper` non-blank; mapper names unique per provider | always |
| A key whose name contains `secret`, `password` or `token` as a segment anywhere (`clientSecret`, `clientSecretValue`, `passwordCredential`, `accessTokenValue`, …), or `private`/`p8` followed by `key`, is refused in `config`; move it to `secrets`. Only a short allow-list of exact Keycloak keys is exempt (`tokenUrl`, `tokenIntrospectionUrl`, `accessTokenIsJwt`, `tokenExchangeAccountLinkingEnabled` and the token-exchange switches) | always |
| `providerId: apple` must author `tokenExchangeAccountLinkingEnabled: false`; `true` or absent fails | always |
| A key authored in both `config` and `secrets`/`devSecrets` is refused | always |
| `devSecrets` take precedence over `secrets`; a literal in `secrets` is accepted | development |
| Every `secrets` value must be a `${env:VAR}` reference whose variable is set; a literal, a `:-fallback`, or any `devSecrets` fails | production |
| Endpoint, issuer and JWKS URLs (`*Url`, `*Uri`, `*Endpoint`, `issuer`) must be absolute `https` URLs with no embedded credentials and no fragment; the exact value is preserved | production |
| Defaults: `enabled` true; `trustEmail`, `storeToken`, `linkOnly`, `hideOnLogin` false | always |

Two authored realms keep independent provider sets, and error messages name
keys and variable names but never a resolved value.

### Account linking policy

No existing account is ever linked to a brokered identity by matching email.
Keycloak's standard first-broker-login flow applies: a conflicting email lands
the user on the review/verify step rather than silently attaching them to
someone else's account. `trustEmail` stays off unless the host decides
otherwise for a provider it controls. Changing this policy is a separate,
reviewed design.

Provider tokens are not stored (`storeToken: false`) unless the host enables it
for a documented use case, because a stored upstream token is a second
credential to protect.

### What is proven, and where

| Evidence | Where |
| --- | --- |
| Serialisation, defaults, every rejection rule above, two realms with independent provider sets, no secret in diagnostics | `packages/compiler/src/authoring/generators/keycloak.test.ts` |
| The Apple jar is present, `kc.sh build` completes, the image boots (also on a read-only rootfs), and the `apple` factory is registered | `.github/workflows/docker-keycloak.yml` |
| Compiler-generated realms import unchanged; a dedicated OIDC provider with a claim mapper logs in end-to-end; repeat login keeps the subject; an e-mail match with an existing local account stops at the confirm-link page and is not linked; a generic SAML provider with attribute mappers logs in end-to-end | `scripts/keycloak-broker-acceptance.ts`, run by the same workflow against the built image |
| Apple web first login and repeat login with a real Service ID and `.p8` key | External product evidence — needs real Apple credentials and a registered domain, so it is not in OSF CI |

The acceptance script also runs locally against any Keycloak 26.5 with a
bootstrap admin, e.g. a container with port 8080 mapped to 18080:

```bash
KC_URL=http://127.0.0.1:18080 KC_INTERNAL_URL=http://127.0.0.1:8080 bun scripts/keycloak-broker-acceptance.ts
```

## What a login carries, and what the organization decides

A verified token proves an identity (`iss` + `sub`) and, through Keycloak's
Organization Membership mapper, which organizations that account belongs to.
It does **not** carry what the person may do in any of them. OpenShapeForge
records that per organization, on the membership row
(`platform.identity_relations.roles`): an organization administrator's
invitation admits the person as `org_admin` or `org_employee`, and
`set_member_role` changes it later — for that organization only. What such a
persona lets the person do is still the realm's decision: a realm that
declares `org_admin` as a composite (a host's `clientRoleComposites`) has it
expanded by the API from the generated realm export, member for member, the
way Keycloak would have expanded it into the token. The same
account invited as an administrator by organization A and as an employee by
organization B is exactly that in each.

The consequence for anyone administering a realm: a client role granted to a
**user** in Keycloak is user-wide and is therefore never read for a person's
session. It would otherwise apply in every organization the account is a
member of, which is the cross-organization escalation this design closes.
Realm roles remain issuer-wide grants for operator-level rights (`Platform.*`),
and service accounts — configured service identities and the per-tenant
API-key clients — keep their client roles, because their clients belong to one
tenant. A federated login changes none of this: the broker admits the person
to the realm, the organization's invitation admits them to the organization.

## How a human signs in: passkeys, and how a federated login fits

Every realm this compiler generates is **passkey-only for humans**. It is worth
reading this section before authoring a provider, because a broker login is the
one thing that gets somebody in without presenting a passkey.

### What the generator emits, always

`generators/keycloak-passkeys.ts` is added to every authored realm, in every
mode. There is deliberately no switch:

- **`browserFlow: passkey-browser`** — cookie, then identity-provider
  redirector, then a sub-flow of *username form → WebAuthn Passwordless*. The
  stock `auth-username-password-form` execution does not appear anywhere in it,
  so there is no password box to type into.
- **`directGrantFlow: passkey-direct-grant-denied`** — a single
  `deny-access-authenticator`. `grant_type=password` is closed at the realm
  rather than left to depend on no user happening to still have a password
  credential. `client_credentials` is a different flow and is untouched, so
  service accounts and confidential clients keep working exactly as before.
- **`webAuthnPolicyPasswordless*`** — resident key required, user verification
  required, ES256/RS256, attestation `none`, a 120 s ceremony timeout, no
  AAGUID allow-list, and authenticator attachment left *unspecified*.
- **required actions** — the complete registry, with
  `webauthn-register-passwordless` on as a **default action** and
  `UPDATE_PASSWORD`, `webauthn-register` (the second-factor variant),
  `CONFIGURE_TOTP` and `CONFIGURE_RECOVERY_AUTHN_CODES` off. A realm import
  *replaces* this list wholesale, so it is stated in full.
- **`resetPasswordAllowed: false`**, forced. Self-service "forgot password" is
  a self-service route to a password credential.

The one value that must be authored is the relying-party id:

```yaml
realm:
  webAuthn:
    rpId: ${env:KEYCLOAK_WEBAUTHN_RP_ID:-example.test}
```

It is a **bare hostname** — no scheme, no port, no path — and it must be
Keycloak's *own* browser-facing hostname or a registrable parent it shares with
the app (`example.com` for a login page on `auth.example.com`). It cannot be
derived from the gateway's `redirectUris`, because the ceremony runs on
Keycloak's login page, not the app's. A production realm that authors none
fails generation instead of shipping a guess.

Hosts that use the immutable OpenShapeForge Keycloak image can also select its
small child login theme:

```yaml
realm:
  loginTheme: openshapeforge
```

The theme inherits Keycloak v2 and changes only the passwordless WebAuthn
registration prompt. Its editable default combines the realm display name,
the browser-reported platform and the local registration date and time, so a
person who registers several passkeys can distinguish them later. A host that
selects this theme must deploy the matching OpenShapeForge Keycloak image; the
realm setting alone does not install theme files in an external Keycloak.

### Where development gets its passwords back

Nowhere in the artifact. The relaxation is
`scripts/keycloak/kc-dev-password-login.py` (in the consuming repository): it
mutates a **running** Keycloak over the admin API, refuses any host that is not
loopback, and writes no file. Nothing it does can be committed, imported by
`--import-realm`, or handed to Helm — which is the point. The safe direction is
what falls out of the build; the unsafe one costs a deliberate command on a
laptop.

### A federated login is an alternative to a passkey, on purpose

`identity-provider-redirector` sits at `ALTERNATIVE` next to the passkey
sub-flow, so a broker login admits the person on its own. For a provider linked
to one tenant's Keycloak Organization — the Google Workspace case — that tenant
*is* the identity authority for their domain, and their own Workspace MFA
policy is what guards the account. Requiring a second, product-specific passkey
on top would make the SSO they bought pointless.

State the consequence plainly when you author a provider: **the passkey-only
guarantee is then only as strong as that tenant's own policy.** A Workspace that
still allows bare passwords re-opens a password path — at the provider, not
here. Two things stop it happening by accident: `hideOnLogin: true` keeps the
button off the realm login page so only members of a linked Organization are
routed to it, and `webauthn-register-passwordless` being a default action means
somebody who arrives over the provider is walked through enrolling a passkey
and leaves with one.

### Somebody whose device cannot make a passkey

Offer these in order. All three are configuration that is already in place, not
a plan.

1. **Cross-device passkey.** The login page shows a QR code; the person scans it
   with a phone that does have a passkey, which signs over the CTAP2 hybrid
   transport. This is the answer for "this laptop has no fingerprint reader",
   and it works only because the passwordless authenticator attachment is left
   unspecified — pinning it to `platform` switches the QR option off.
2. **A roaming security key** (USB/NFC). Enabled by the same unspecified
   attachment plus the empty `acceptableAaguids`; an AAGUID allow-list is a
   hardware allow-list and would exclude most keys and every phone.
3. **An admin-issued enrolment link**, for somebody with neither. A realm
   administrator holding `realm-management` `manage-users` — in the Hubble
   deployment that is the `openshapeforge-auth-api` service account, the same
   privilege the employee invitation runs on — calls:

   ```
   PUT /admin/realms/<realm>/users/<id>/execute-actions-email?lifespan=<seconds>
   ["webauthn-register-passwordless"]
   ```

   Keycloak e-mails a Keycloak action token. It is **single use** and **time
   boxed** — pass `lifespan` explicitly; the realm default is
   `actionTokenGeneratedByAdminLifespan`, 12 hours. Redeeming it drops the
   person straight into passkey enrolment, with no password anywhere in the
   path. It **cannot be self-triggered**: `resetPasswordAllowed` is off, so
   there is no "e-mail me a link" form on the login page. An administrator has
   to do it, and the call lands in the admin event log.

   This is also why `VERIFY_EMAIL` is left enabled: the whole recovery story
   rests on the address being the person's.

## 3. Deployment and reconciliation

`bun run generate` writes `keycloak/<realm>-realm.json`. The local compose
stack and a *fresh* Keycloak import it with `--import-realm`.

An **existing** realm does not: `--import-realm` skips a realm that already
exists, so adding a provider to a running environment is a reconciliation
step — apply the generated realm through the admin API or Keycloak's partial
import (`identityProviders` and `identityProviderMappers` sections), or
recreate the realm where that is acceptable. Plan it like any other realm
change: the generated file is the source of truth, the running realm is
brought to it.

Production keeps the bring-your-own-issuer posture: the Helm Keycloak subchart
stays optional and off by default, and a host that runs its own Keycloak
applies the same generated realm there.

## Supply chain: Keycloak ↔ provider lockstep

Third-party provider jars state compatibility per Keycloak release, and their
bytes are pinned. Three files must agree, and `bun run check:keycloak-lockstep`
(run in CI before the SPI build) fails when they do not:

| File | Holds |
| --- | --- |
| `packages/keycloak-spi/Dockerfile` | The Keycloak base image tag+digest; `ARG APPLE_IDP_VERSION` and `ARG APPLE_IDP_SHA512`, verified with `sha512sum -c` before the jar enters the image |
| `packages/keycloak-spi/pom.xml` | `<keycloak.version>` the SPI compiles against |
| `packages/keycloak-spi/provider-compatibility.json` | For each provider jar: version, SHA-512, source, license, minimum Keycloak; plus the Keycloak version the pins were reviewed against |

**Bumping Keycloak**: update the Dockerfile `FROM` and `pom.xml` as before,
then confirm each provider's compatibility statement covers the new version
(bump the provider if not) and set `"keycloak"` in the compatibility record to
the new version. Leaving the record untouched fails the check by design.

**Bumping a provider jar**: download the release artifact, compute
`shasum -a 512`, update the Dockerfile ARGs *and* the compatibility record
(`version`, `sha512`, `artifact`, `release`), and the notice in
`packages/keycloak-spi/THIRD-PARTY-NOTICES.md`. The image workflow then proves
the jar is present, that `kc.sh build` still completes, that Keycloak boots
(also on a read-only root filesystem), and that the `apple` factory is
registered in `/admin/serverinfo`.
