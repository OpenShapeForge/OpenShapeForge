# Third-party notices — Keycloak image

The root [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) is generated from
the JavaScript dependency tree and cannot see what this directory's Dockerfile
layers into the Keycloak image. The jars below are recorded here instead, and
their pins are machine-checked by `bun run check:keycloak-lockstep` against
[provider-compatibility.json](provider-compatibility.json).

## apple-identity-provider 1.17.0

- Project: klausbetz/apple-identity-provider-keycloak
  (https://github.com/klausbetz/apple-identity-provider-keycloak)
- Release: https://github.com/klausbetz/apple-identity-provider-keycloak/releases/tag/1.17.0
- Artifact: `apple-identity-provider-1.17.0.jar`
- SHA-512: `04949c18bd2819f6134f7a8fdf446e471036241c537d451e7bf1c627d8eefb1f72374d238bf0037155e725531c587065cfabf1c3f0b7f0df86fb7138effd6bba`
- License: **Apache-2.0** — the full license text is reproduced in the root
  notices file under "Apache-2.0".
- Compatibility: extension releases `>= 1.17.0` target Keycloak `>= 26.5.0`;
  reviewed against the image's Keycloak 26.5.3 on 2026-09-03.
- Role: registers the `apple` identity-provider factory (Sign in with Apple).
  Dormant until a realm authors `providerId: apple`; see
  [docs/identity-providers.md](../../docs/identity-providers.md).

The jar is downloaded at image build time from the GitHub release above and
verified against the pinned SHA-512 before it is copied into the image. It is
not vendored into this repository and not modified.
