// SPDX-License-Identifier: BUSL-1.1
/**
 * The opening sentence of a session: who, where, what they may do, in which
 * language. Pure: no database, no server. The negative rule matters most —
 * no realm role name and no half sentence may ever come out.
 */
import { describe, expect, it } from "bun:test";
import { resolveLocale } from "../locale.js";
import { openingSentence } from "../session-opening.js";

const nl = resolveLocale({ user: "nl" });
const en = resolveLocale({ user: "en" });
const fr = resolveLocale({ user: "fr-BE" });

const KEYCLOAK_NOISE = ["default-roles-openshapeforge", "offline_access", "uma_authorization"];

describe("openingSentence", () => {
  it("names the person, the organization and the rights in Dutch", () => {
    const sentence = openingSentence({
      name: "Hans Eilers",
      organization: "Zerocopter",
      roles: [
        "org_admin",
        "Pentest.All.ReadWrite",
        "Pentest.All.Read",
        "CpqCatalog.All.ReadWrite",
        ...KEYCLOAK_NOISE,
      ],
      locale: nl,
    });
    expect(sentence).toBe(
      "Je assisteert Hans Eilers bij Zerocopter; Hans Eilers is organisatiebeheerder en mag " +
        "offertes en de catalogus beheren en assessments en bevindingen beheren. " +
        "Antwoord in het Nederlands.",
    );
  });

  it("says the same in English for an English reader", () => {
    const sentence = openingSentence({
      name: "Hans Dev",
      organization: "Zerocopter",
      roles: ["org_employee", "Pentest.All.Read", "integration_user", ...KEYCLOAK_NOISE],
      locale: en,
    });
    expect(sentence).toBe(
      "You assist Hans Dev at Zerocopter; Hans Dev is an employee and may " +
        "use integrations and view assessments and findings. Answer in English.",
    );
  });

  it("falls back to an English sentence for a language it is not authored in, and still names that language", () => {
    const sentence = openingSentence({
      name: "Zoë Pentester",
      organization: "Zerocopter",
      roles: ["pentester", "Pentest.All.ReadWrite"],
      locale: fr,
    });
    expect(sentence).toBe(
      "You assist Zoë Pentester at Zerocopter; Zoë Pentester is a pentester and may " +
        "manage assessments and findings. Answer in French.",
    );
  });

  it("closes the sentence when the person has no roles, and without a composite role", () => {
    expect(
      openingSentence({ name: "Hans Dev", organization: "Zerocopter", roles: KEYCLOAK_NOISE, locale: nl }),
    ).toBe("Je assisteert Hans Dev bij Zerocopter; Hans Dev heeft nog geen rollen. Antwoord in het Nederlands.");
    expect(
      openingSentence({
        name: "Hans Dev",
        organization: "Zerocopter",
        roles: ["Relations.All.Read"],
        locale: en,
      }),
    ).toBe(
      "You assist Hans Dev at Zerocopter; Hans Dev may view clients and other relations. Answer in English.",
    );
  });

  it("describes an unknown Area.All.* role from its shape and drops anything else, never the role name", () => {
    const sentence = openingSentence({
      name: "Hans Dev",
      organization: "Zerocopter",
      roles: ["Invoices.All.ReadWrite", "Invoices.All.Read", "some_internal_flag"],
      locale: en,
    });
    expect(sentence).toBe(
      "You assist Hans Dev at Zerocopter; Hans Dev may manage invoices. Answer in English.",
    );
    expect(sentence).not.toContain("some_internal_flag");
    expect(sentence).not.toContain("Invoices.All");
  });

  it("is null — never a half sentence — without a name or without an organization", () => {
    expect(openingSentence({ name: null, organization: "Zerocopter", roles: ["org_admin"], locale: nl })).toBeNull();
    expect(openingSentence({ name: "Hans Dev", organization: null, roles: ["org_admin"], locale: nl })).toBeNull();
    expect(openingSentence({ name: "", organization: "", roles: [], locale: en })).toBeNull();
  });
});
