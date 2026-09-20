// SPDX-License-Identifier: BUSL-1.1
/**
 * The opening sentence of a session: who, where, what they may do, in which
 * language. Pure: no database, no server. The negative rule matters most —
 * no realm role name and no half sentence may ever come out.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { resolveLocale } from "../locale.js";
import { __setRoleLabelsForTests } from "../session-labels.js";
import { openingSentence } from "../session-opening.js";

const nl = resolveLocale({ user: "nl" });
const en = resolveLocale({ user: "en" });
const fr = resolveLocale({ user: "fr-BE" });

const KEYCLOAK_NOISE = ["default-roles-openshapeforge", "offline_access", "uma_authorization"];

/**
 * A host's roles, the way its authorizationPatch declares them (`roleLabels`)
 * and the compiler emits them: a persona with a label, permission roles with
 * a phrase. The engine itself knows only the base realm's roles.
 */
const HOST_ROLE_LABELS = {
  org_admin: {
    label: { en: "Organization administrator", nl: "Organisatiebeheerder" },
    phrase: { en: "organization administrator", nl: "organisatiebeheerder" },
  },
  org_employee: { label: { en: "Employee", nl: "Medewerker" }, phrase: { en: "employee", nl: "medewerker" } },
  auditor: { label: { en: "Auditor" } },
  "Audit.All.ReadWrite": {
    phrase: { en: "manage audits and findings", nl: "audits en bevindingen beheren" },
  },
  "Audit.All.Read": {
    phrase: { en: "view audits and findings", nl: "audits en bevindingen inzien" },
  },
  "Catalog.All.ReadWrite": {
    phrase: { en: "manage quotes and the catalog", nl: "offertes en de catalogus beheren" },
  },
  integration_user: { phrase: { en: "use integrations", nl: "koppelingen gebruiken" } },
};

describe("openingSentence", () => {
  afterEach(() => __setRoleLabelsForTests(null));

  it("names the person, the organization and the rights in Dutch, from the base realm's authored labels", () => {
    const sentence = openingSentence({
      name: "Hans Eilers",
      organization: "Zerocopter",
      roles: [
        "org_admin",
        "Relations.All.ReadWrite",
        "Relations.All.Read",
        "CaseFile.All.ReadWrite",
        ...KEYCLOAK_NOISE,
      ],
      locale: nl,
    });
    expect(sentence).toBe(
      "Je assisteert Hans Eilers bij Zerocopter; Hans Eilers is organisatiebeheerder en mag " +
        "dossiers beheren en klanten en andere relaties beheren. " +
        "Antwoord in het Nederlands.",
    );
  });

  it("describes a host's roles in the words the host authored on them", () => {
    __setRoleLabelsForTests(HOST_ROLE_LABELS);
    expect(
      openingSentence({
        name: "Hans Eilers",
        organization: "Zerocopter",
        roles: ["org_admin", "Audit.All.ReadWrite", "Audit.All.Read", "Catalog.All.ReadWrite", ...KEYCLOAK_NOISE],
        locale: nl,
      }),
    ).toBe(
      "Je assisteert Hans Eilers bij Zerocopter; Hans Eilers is organisatiebeheerder en mag " +
        "audits en bevindingen beheren en offertes en de catalogus beheren. " +
        "Antwoord in het Nederlands.",
    );
    expect(
      openingSentence({
        name: "Hans Dev",
        organization: "Zerocopter",
        roles: ["org_employee", "Audit.All.Read", "integration_user", ...KEYCLOAK_NOISE],
        locale: en,
      }),
    ).toBe(
      "You assist Hans Dev at Zerocopter; Hans Dev is an employee and may " +
        "view audits and findings and use integrations. Answer in English.",
    );
  });

  it("falls back to an English sentence for a language it is not authored in, and still names that language", () => {
    __setRoleLabelsForTests(HOST_ROLE_LABELS);
    const sentence = openingSentence({
      name: "Zoë Auditor",
      organization: "Zerocopter",
      roles: ["auditor", "Audit.All.ReadWrite"],
      locale: fr,
    });
    // A persona with a label and no phrase is phrased from its label.
    expect(sentence).toBe(
      "You assist Zoë Auditor at Zerocopter; Zoë Auditor is an auditor and may " +
        "manage audits and findings. Answer in French.",
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
