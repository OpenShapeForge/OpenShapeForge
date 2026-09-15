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
    expect(properties.trim()).toBe("parent=keycloak.v2");
    expect(dockerfile).toContain(
      "COPY theme/openshapeforge /opt/keycloak/themes/openshapeforge",
    );
  });

  test("keeps the stock WebAuthn form contract and suggests an editable unique label", () => {
    for (const field of [
      "clientDataJSON",
      "attestationObject",
      "publicKeyCredentialId",
      "authenticatorLabel",
      "transports",
      "error",
    ]) {
      expect(template).toContain(`name="${field}"`);
    }
    expect(template).toContain('import { registerByWebAuthn }');
    expect(template).toContain("realm.displayName");
    expect(template).toContain("navigator.userAgentData?.platform");
    expect(template).toContain("new Intl.DateTimeFormat");
    expect(template).toContain("initLabel : suggestedLabel");
    expect(template).toContain('initLabelPrompt : ${msg("webauthn-registration-init-label-prompt")?c}');
  });
});
