# Local development account authentication

This optional, separately built Keycloak SPI supports a localhost account chooser. It is disabled unless `OSF_LOCAL_LOGIN_ENABLED=true` and the realm is explicitly listed in `OSF_LOCAL_LOGIN_REALMS`. Base URI, request URI and OAuth redirect URI must all use HTTP(S) loopback or `.localhost`. Disabled users and service accounts cannot sign in. Credentials, required actions, roles and organization membership remain intact. Normal sign-in remains available.

Build with `mvn -f packages/keycloak-spi/local-development/pom.xml package`. The production Dockerfile does not build or copy this module. Never distribute the jar or its opt-in configuration to shared or hosted environments. The host owns the optional `osf-local-development` theme and account-picker UI; the form contract is `local-accounts.ftl`, attributes `localAccounts`, `localLanguage`, and POST fields `account` and `mode` (`normal` resumes normal sign-in).

Focused Maven tests cover opt-in, realm selection and refusal of external or spoofed request/callback origins. This source is retained for isolated development only, not as a production authentication method.

The connection peer must be a literal loopback address by default. A localhost
Docker launcher may explicitly trust its concrete Docker gateway IPs via
`OSF_LOCAL_LOGIN_TRUSTED_PEERS`, only together with a loopback-published port
and disabled `KC_PROXY_HEADERS`. Never trust forwarded peer addresses, DNS names,
subnets or arbitrary LAN peers. URI checks are secondary; hostname configuration
is not caller identity. Hosts own the account-picker translations.
