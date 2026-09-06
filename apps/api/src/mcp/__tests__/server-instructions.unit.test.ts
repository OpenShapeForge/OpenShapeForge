// SPDX-License-Identifier: BUSL-1.1
/**
 * The `initialize` instructions as one text: the opening sentence comes
 * first, the fixed guidance follows in its order, and the client's name
 * reaches the presentation rules. Pure: no server.
 */
import { describe, expect, it } from "bun:test";
import { resolveLocale } from "../locale.js";
import { ONBOARDING_INSTRUCTION } from "../onboarding.js";
import {
  audienceAndPresentationInstruction,
  buildServerInstructions,
  INSTRUCTIONS,
  languageInstruction,
} from "../server-instructions.js";
import { UPDATE_INSTRUCTION } from "../update-notices.js";

const nl = resolveLocale({ user: "nl" });
const client = { name: "Claude Desktop", version: "1.2.3", capabilities: ["elicitation"] };

describe("buildServerInstructions", () => {
  it("puts the opening sentence first, then the fixed guidance in order", () => {
    const opening = "Je assisteert Hans Dev bij Zerocopter; Hans Dev is medewerker. Antwoord in het Nederlands.";
    const text = buildServerInstructions({
      opening,
      oauthCallbackUrl: null,
      guidesBeforeCreate: [{ name: "pentest_guide", entity: "Assessment" }],
      locale: nl,
      client,
    });
    expect(text.startsWith(`${opening} ${INSTRUCTIONS}`)).toBe(true);
    const order = [
      opening,
      INSTRUCTIONS,
      "Before creating a Assessment, call pentest_guide",
      "Data acquisition —",
      ONBOARDING_INSTRUCTION,
      "Talking to a person —",
      "introduced itself as Claude Desktop 1.2.3",
      "Language — this person reads Dutch (nl)",
      UPDATE_INSTRUCTION,
    ];
    const positions = order.map((part) => text.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it("leaves the opening out entirely when the session has no person", () => {
    const text = buildServerInstructions({
      opening: null,
      oauthCallbackUrl: null,
      guidesBeforeCreate: [],
      locale: nl,
      client: null,
    });
    expect(text.startsWith(INSTRUCTIONS)).toBe(true);
    expect(text).not.toContain("You assist");
    expect(text).not.toContain("Je assisteert");
    expect(text).not.toContain("introduced itself");
  });

  it("states the OAuth redirect URL only when an Adapter can connect", () => {
    const withUrl = buildServerInstructions({
      opening: null,
      oauthCallbackUrl: "https://hubble.localhost/api/entity-oauth/callback",
      guidesBeforeCreate: [],
      locale: nl,
      client: null,
    });
    expect(withUrl).toContain(
      "OAuth redirect (callback) URL is https://hubble.localhost/api/entity-oauth/callback",
    );
  });
});

describe("audienceAndPresentationInstruction", () => {
  it("passes the client's own name through and invents nothing about it", () => {
    const withClient = audienceAndPresentationInstruction(client);
    const without = audienceAndPresentationInstruction(null);
    expect(withClient).toBe(
      `${without} The client in front of you introduced itself as Claude Desktop 1.2.3.`,
    );
    expect(without).toContain("Use whatever the client in front of you can render");
  });
});

describe("languageInstruction", () => {
  it("names the language and where it was decided", () => {
    expect(languageInstruction(resolveLocale({ user: "nl-NL" }))).toContain(
      "reads Dutch (nl), from their own setting in the identity provider",
    );
    expect(languageInstruction(resolveLocale({ user: null, realmDefault: "en" }))).toContain(
      "reads English (en), from this deployment's default",
    );
  });
});
