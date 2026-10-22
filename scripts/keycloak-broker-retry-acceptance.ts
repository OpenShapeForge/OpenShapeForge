// SPDX-License-Identifier: BUSL-1.1
/** Native isolated Keycloak contract proof; never targets a hosted realm. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
const KC_URL = process.env.KC_URL ?? "http://127.0.0.1:8080";
const u = new URL(KC_URL);
if (u.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(u.hostname))
  throw Error("Isolated loopback Keycloak required.");
const INTERNAL = process.env.KC_INTERNAL_URL ?? KC_URL;
const CALLBACK = "http://127.0.0.1/callback",
  IDP = "osf-retry-idp",
  BROKER = "osf-retry-broker",
  PASSWORD = "Local-only-retry-1416!";
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
  console.log("  ok " + message);
}
class Session {
  private cookies = new Map<string, { value: string; path: string }>();

  private store(res: Response) {
    const headers =
      (
        res.headers as unknown as { getSetCookie?: () => string[] }
      ).getSetCookie?.() ?? [];
    for (const line of headers) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const pathAttr = attrs
        .map((a) => a.trim())
        .find((a) => a.toLowerCase().startsWith("path="));
      const path = pathAttr ? pathAttr.slice(5) : "/";
      const key = `${name}@${path}`;
      if (value === "" || /max-age=0/i.test(line)) this.cookies.delete(key);
      else this.cookies.set(key, { value, path });
    }
  }

  forgetRealm(realm: string) {
    for (const [key, cookie] of this.cookies)
      if (cookie.path.startsWith("/realms/" + realm)) this.cookies.delete(key);
  }
  private header(url: string): string {
    const path = new URL(url).pathname;
    return [...this.cookies.entries()]
      .filter(([, c]) => path.startsWith(c.path))
      .map(([key, c]) => `${key.slice(0, key.indexOf("@"))}=${c.value}`)
      .join("; ");
  }

  /** One request; never follows redirects itself. */
  async request(
    url: string,
    init: { method?: string; body?: URLSearchParams } = {},
  ): Promise<Response> {
    url = new URL(url, KC_URL).toString();
    const res = await fetch(url, {
      method: init.method ?? "GET",
      redirect: "manual",
      headers: {
        cookie: this.header(url),
        ...(init.body
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: init.body,
    });
    this.store(res);
    return res;
  }

  /**
   * Follow redirects until a non-redirect response, or until the Location
   * lands on the product callback — which a browser would leave Keycloak for.
   */
  async follow(
    res: Response,
    stopAt = CALLBACK,
    max = 15,
  ): Promise<{ res: Response; url: string }> {
    let current = res;
    let url = current.url;
    for (let i = 0; i < max; i++) {
      if (current.status < 300 || current.status >= 400)
        return { res: current, url };
      const location = current.headers.get("location");
      if (!location) throw new Error(`redirect without Location from ${url}`);
      url = new URL(location, url).toString();
      if (url.startsWith(stopAt)) return { res: current, url };
      current = await this.request(url);
    }
    throw new Error("too many redirects");
  }
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** The action + hidden inputs of the first <form> whose tag matches `test`. */
function parseForm(
  html: string,
  test: (tag: string) => boolean,
): { action: string; fields: URLSearchParams } {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map(
    (m) => m[0],
  );
  const form = forms.find((f) => test(f.slice(0, f.indexOf(">") + 1)));
  if (!form)
    throw new Error(`no matching <form> in page:\n${html.slice(0, 2000)}`);
  const action = /action="([^"]*)"/i.exec(form)?.[1];
  if (!action) throw new Error("form without action");
  const fields = new URLSearchParams();
  for (const input of form.matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0];
    if (!/type="hidden"/i.test(tag)) continue;
    const name = /name="([^"]*)"/i.exec(tag)?.[1];
    const value = /value="([^"]*)"/i.exec(tag)?.[1] ?? "";
    if (name) fields.set(name, unescapeHtml(value));
  }
  return { action: unescapeHtml(action), fields };
}

async function main() {
  const auth = await fetch(
    KC_URL + "/realms/master/protocol/openid-connect/token",
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: process.env.KC_ADMIN_USER ?? "admin",
        password: process.env.KC_ADMIN_PASSWORD ?? "admin",
      }),
    },
  );
  check(auth.ok, "isolated administration authenticated");
  const { access_token } = await auth.json();
  async function api(path: string, method = "GET", body?: unknown) {
    const r = await fetch(KC_URL + "/admin/realms" + path, {
      method,
      headers: {
        authorization: "Bearer " + access_token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!r.ok) throw Error("Native fixture status " + r.status + " " + path);
    const text = await r.text();
    return text ? JSON.parse(text) : undefined;
  }
  const created: string[] = [];
  try {
    const upstreamUsers = ["wrong", "linked"].map((username) => ({
      username,
      email: username + "@example.test",
      firstName: "Synthetic",
      lastName: username,
      enabled: true,
      emailVerified: true,
      credentials: [{ type: "password", value: PASSWORD, temporary: false }],
    }));
    await api("", "POST", {
      realm: IDP,
      enabled: true,
      sslRequired: "none",
      loginTheme: "openshapeforge",
      clients: [
        {
          clientId: "broker",
          protocol: "openid-connect",
          publicClient: false,
          secret: "isolated-fixture-broker-secret",
          standardFlowEnabled: true,
          redirectUris: [
            KC_URL + "/realms/" + BROKER + "/broker/workforce/endpoint",
          ],
          defaultClientScopes: ["basic", "profile", "email"],
        },
      ],
      users: upstreamUsers,
    });
    created.push(IDP);
    await api("/" + IDP + "/clients", "POST", {clientId:"upstream-app",protocol:"openid-connect",publicClient:true,standardFlowEnabled:true,redirectUris:[CALLBACK],defaultClientScopes:["basic","profile","email"]});
    const [linked] = await api("/" + IDP + "/users?username=linked&exact=true");
    await api("", "POST", {
      realm: BROKER,
      internationalizationEnabled: true,
      supportedLocales: ["en", "nl"],
      defaultLocale: "en",
      enabled: true,
      sslRequired: "none",
      organizationsEnabled: true,
      loginTheme: "openshapeforge",
      clients: [
        {
          clientId: "relying",
          protocol: "openid-connect",
          publicClient: true,
          standardFlowEnabled: true,
          consentRequired: true,
          redirectUris: [CALLBACK],
          defaultClientScopes: ["basic", "profile", "email"],
          optionalClientScopes: ["organization"],
        },
      ],
      authenticationFlows: [
        {
          alias: "existing-linked-only",
          providerId: "basic-flow",
          topLevel: true,
          builtIn: false,
          authenticationExecutions: [
            {
              authenticator: "osf-broker-account-retry",
              requirement: "REQUIRED",
              priority: 10,
              authenticatorFlow: false,
              userSetupAllowed: false,
            },
            {
              authenticator: "deny-access-authenticator",
              requirement: "REQUIRED",
              priority: 20,
              authenticatorFlow: false,
              userSetupAllowed: false,
            },
          ],
        },
      ],
      identityProviders: [
        {
          alias: "workforce",
          providerId: "oidc",
          enabled: true,
          trustEmail: false,
          firstBrokerLoginFlowAlias: "existing-linked-only",
          config: {
            clientId: "broker",
            clientSecret: "isolated-fixture-broker-secret",
            authorizationUrl:
              KC_URL + "/realms/" + IDP + "/protocol/openid-connect/auth",
            tokenUrl:
              INTERNAL + "/realms/" + IDP + "/protocol/openid-connect/token",
            jwksUrl:
              INTERNAL + "/realms/" + IDP + "/protocol/openid-connect/certs",
            issuer: KC_URL + "/realms/" + IDP,
            validateSignature: "true",
            useJwksUrl: "true",
            defaultScope: "openid profile email",
          },
        },
      ],
      users: [
        {
          username: "linked-local",
          email: "linked@example.test",
          firstName: "Synthetic",
          lastName: "Linked",
          emailVerified: true,
          enabled: true,
          federatedIdentities: [
            {
              identityProvider: "workforce",
              userId: linked.id,
              userName: "linked",
            },
          ],
        },
      ],
    });
    created.push(BROKER);
    const [local] = await api(
      "/" + BROKER + "/users?username=linked-local&exact=true",
    );
    for (const alias of ["org-first", "org-second"]) {
      await api("/" + BROKER + "/organizations", "POST", {
        name: alias,
        alias,
        enabled: true,
      });
      const [org] = await api("/" + BROKER + "/organizations?search=" + alias);
      await api(
        "/" + BROKER + "/organizations/" + org.id + "/members",
        "POST",
        local.id,
      );
    }
    const memberships = await api(
      "/" + BROKER + "/organizations/members/" + local.id + "/organizations",
    );
    check(
      memberships.length === 2,
      "the native user has exactly two organization memberships",
    );
    let verifier = "",
      state = "";
    function authorize() {
      verifier = randomBytes(48).toString("base64url");
      state = randomUUID();
      return (
        KC_URL +
        "/realms/" +
        BROKER +
        "/protocol/openid-connect/auth?" +
        new URLSearchParams({
          client_id: "relying",
          redirect_uri: CALLBACK,
          response_type: "code",
          scope: "openid profile email organization",
          prompt: "consent",
          state,
          kc_idp_hint: "workforce",
          ui_locales: "nl",
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
        })
      );
    }
    async function login(session: Session, html: string, username: string) {
      const form = parseForm(html, (tag) => /id="kc-form-login"/.test(tag));
      return session.follow(
        await session.request(form.action, {
          method: "POST",
          body: new URLSearchParams({
            username,
            password: PASSWORD,
            credentialId: "",
          }),
        }),
      );
    }
    async function retry(session: Session, html: string, username: string) {
      const form = parseForm(html, (tag) =>
        /id="kc-broker-account-retry-form"/.test(tag),
      );
      form.fields.set("retry", "true");
      let r = await session.follow(
        await session.request(form.action, {
          method: "POST",
          body: form.fields,
        }),
      );
      let body = await r.res.text();
      const reset =
        /id="reset-login"[^>]*onclick="location.href='([^']+)'"/.exec(
          body,
        )?.[1];
      if (reset) {
        r = await session.follow(await session.request(unescapeHtml(reset)));
        body = await r.res.text();
      }
      return login(session, body, username);
    }
    async function consent(
      session: Session,
      outcome: { res: Response; url: string },
      accept: boolean,
    ) {
      let html = await outcome.res.text();
      if (html.includes("organization-org-first")) {
        const form = parseForm(html, (tag) => /select-organization/.test(tag));
        const choice = /<button[^>]*id="organization-org-first"[^>]*>/.exec(
          html,
        )?.[0];
        check(choice, "organization selection rendered");
        const id = /value="([^"]+)"/.exec(choice)?.[1];
        check(id, "organization choice has native id");
        form.fields.set("organizationId", id);
        outcome = await session.follow(
          await session.request(form.action, {
            method: "POST",
            body: form.fields,
          }),
        );
        html = await outcome.res.text();
      }
      check(
        outcome.res.status === 200 &&
          html.includes('name="accept"') &&
          html.includes('name="cancel"'),
        "native consent renders with two memberships",
      );
      check(
        !html.includes('id="kc-switch-organization-form"'),
        "consent omits the unsupported browser switch form",
      );
      const form = parseForm(html, (tag) => /consent/.test(tag));
      form.fields.set(accept ? "accept" : "cancel", accept ? "Yes" : "No");
      return session.follow(
        await session.request(form.action, {
          method: "POST",
          body: form.fields,
        }),
      );
    }
    let session = new Session();
    const upstreamVerifier = randomBytes(48).toString("base64url");
    const upstreamUrl = KC_URL + "/realms/" + IDP + "/protocol/openid-connect/auth?" + new URLSearchParams({client_id:"upstream-app",redirect_uri:CALLBACK,response_type:"code",scope:"openid profile email",code_challenge:createHash("sha256").update(upstreamVerifier).digest("base64url"),code_challenge_method:"S256"});
    let out = await session.follow(await session.request(upstreamUrl));
    out = await login(session, await out.res.text(), "wrong");
    check(out.url.startsWith(CALLBACK), "the first app authenticates the other upstream account");
    const upstreamResponse = await fetch(KC_URL + "/realms/" + IDP + "/protocol/openid-connect/token", {method:"POST",body:new URLSearchParams({grant_type:"authorization_code",client_id:"upstream-app",redirect_uri:CALLBACK,code:new URL(out.url).searchParams.get("code")!,code_verifier:upstreamVerifier})});
    check(upstreamResponse.ok,"the first app exchanges its authorization code");
    const upstreamTokens = await upstreamResponse.json();
    const userinfo = () => fetch(KC_URL + "/realms/" + IDP + "/protocol/openid-connect/userinfo",{headers:{authorization:"Bearer "+upstreamTokens.access_token}});
    check((await userinfo()).ok,"the first app session is initially usable");
    out = await session.follow(await session.request(authorize()));
    let html = await out.res.text();
    check(
      html.includes("Ander account gebruiken"),
      "requested Dutch locale renders the recovery form",
    );
    check(
      html.includes('name="retry"') && !out.url.startsWith(CALLBACK),
      "unlinked account gets recovery without a code",
    );
    out = await retry(session, html, "wrong");
    html = await out.res.text();
    check(
      html.includes("Ander account gebruiken"),
      "requested locale survives account retry",
    );
    check(
      html.includes('name="retry"') && !out.url.startsWith(CALLBACK),
      "retrying the unlinked account remains denied",
    );
    out = await retry(session, html, "linked");
    out = await consent(session, out, true);
    check(
      out.url.startsWith(CALLBACK) &&
        new URL(out.url).searchParams.get("state") === state,
      "account switch preserves original callback and state",
    );
    const token = await fetch(
      KC_URL + "/realms/" + BROKER + "/protocol/openid-connect/token",
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "relying",
          redirect_uri: CALLBACK,
          code: new URL(out.url).searchParams.get("code")!,
          code_verifier: verifier,
        }),
      },
    );
    check(token.ok, "original PKCE verifier exchanges the authorization code");
    const tokens = await token.json();
    const claims = JSON.parse(
      Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(),
    );
    check(
      claims.sub === local.id,
      "issued token belongs to the explicitly linked account",
    );
    check(
      (await api("/" + BROKER + "/users")).length === 1,
      "no account was created or linked for the rejected identity",
    );
    const priorIdentity = await userinfo();
    check(priorIdentity.ok && (await priorIdentity.json()).preferred_username === "wrong", "account choice retains the first app's original account and access session");
    const priorRefresh = await fetch(KC_URL + "/realms/" + IDP + "/protocol/openid-connect/token", {method:"POST",body:new URLSearchParams({grant_type:"refresh_token",client_id:"upstream-app",refresh_token:upstreamTokens.refresh_token})});
    check(priorRefresh.ok,"the first account's refresh session also survives switching to the linked account");
    session.forgetRealm(BROKER);
    out = await session.follow(await session.request(authorize()));
    const ssoBody = await out.res.clone().text();
    check(
      !ssoBody.includes('name="password"') && !ssoBody.includes('name="retry"'),
      "already linked upstream SSO is retained without reauthentication",
    );
    out = await consent(session, out, false);
    check(
      new URL(out.url).searchParams.get("error") === "access_denied" &&
        new URL(out.url).searchParams.get("state") === state,
      "native consent rejection preserves state and issues no code",
    );
    session = new Session();
    out = await session.follow(await session.request(authorize()));
    out = await login(session, await out.res.text(), "wrong");
    html = await out.res.text();
    const cancel = parseForm(html, (tag) =>
      /id="kc-broker-account-retry-form"/.test(tag),
    );
    cancel.fields.set("cancel", "true");
    out = await session.follow(
      await session.request(cancel.action, {
        method: "POST",
        body: cancel.fields,
      }),
    );
    check(
      new URL(out.url).searchParams.get("error") === "access_denied" &&
        new URL(out.url).searchParams.get("state") === state,
      "cancel returns original state with access denied",
    );
    console.log("Native broker retry and consent acceptance passed.");
  } finally {
    for (const realm of created.reverse()) await api("/" + realm, "DELETE");
  }
}
await main();
