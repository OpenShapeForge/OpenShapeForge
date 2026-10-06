// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "packages", "keycloak-spi");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const properties = readFileSync(
  join(root, "theme", "openshapeforge", "login", "theme.properties"),
  "utf8",
);
const template = readFileSync(
  join(root, "theme", "openshapeforge", "login", "webauthn-register.ftl"),
  "utf8",
);

describe("OpenShapeForge Keycloak login theme", () => {
  test("inherits the pinned v2 theme and is copied into the immutable image", () => {
    expect(properties.trim().split("\n")).toEqual(["parent=keycloak.v2", "scripts=js/accountChanged.js"]);
    expect(dockerfile).toContain(
      "COPY theme/openshapeforge /opt/keycloak/themes/openshapeforge",
    );
  });

  test("keeps the stock WebAuthn form contract and saves an automatic unique label", () => {
    for (const field of [
      "clientDataJSON",
      "attestationObject",
      "publicKeyCredentialId",
      "authenticatorLabel",
      "transports",
      "authenticatorAttachment",
      "error",
    ]) {
      expect(template).toContain(`name="${field}"`);
    }
    expect(template).toContain('import { registerByWebAuthn }');
    const script = readFileSync(join(root, "theme/openshapeforge/login/resources/js/webauthnRegisterAutoLabel.js"), "utf8");
    expect(script).not.toContain("window.prompt");
    expect(script).toContain('document.getElementById("authenticatorLabel").value = initLabel');
    expect(script).toContain("navigator.credentials.create({publicKey})");
    expect(template).toContain("realm.displayName");
    expect(template).toContain("navigator.userAgentData?.platform");
    expect(template).toContain("new Intl.DateTimeFormat");
    expect(template).toContain("initLabel : suggestedLabel");
    expect(template).toContain("residentKey : ${residentKey?c}");
    expect(template).toContain('initLabelPrompt : ${msg("webauthn-registration-init-label-prompt")?c}');
  });
});

test("account completion redirects only a native info link carrying the replacement marker", async () => {
  const { runInNewContext } = await import("node:vm");
  const script = readFileSync(new URL("../packages/keycloak-spi/theme/openshapeforge/login/resources/js/accountChanged.js", import.meta.url), "utf8");
  for (const [href, redirect] of [
    ["https://app.example.test/acme?account_changed=1", true],
    ["http://127.0.0.1:3701/acme?account_changed=1", true],
    ["https://app.example.test/acme", false],
    ["http://external.example/acme?account_changed=1", false],
    [null, false],
  ] as const) {
    const navigations: string[] = [];
    runInNewContext(script, { URL,
      document: { querySelector: (selector: string) => { expect(selector).toBe("#kc-info-message a[href]"); return href ? { href } : null; } },
      window: { addEventListener: (event: string, callback: () => void) => { expect(event).toBe("DOMContentLoaded"); callback(); },
        location: { replace: (url: string) => navigations.push(url) } },
    });
    expect(navigations).toEqual(redirect ? [href!] : []);
  }
});
