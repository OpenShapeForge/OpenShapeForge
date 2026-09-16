// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  DOCUMENT_TYPE_SEED_LOCALES,
  loadDocumentTypeCatalog,
  loadDocumentTypeSeedRecords,
} from "./seed.js";

const catalogEntries = [
  {
    code: "incoming_mail",
    labels: { en: "Incoming mail", nl: "Inkomende post", fr: "Courrier entrant" },
  },
  {
    code: "outgoing_mail",
    labels: { en: "Outgoing mail", nl: "Uitgaande post", fr: "Courrier sortant" },
  },
  { code: "note", labels: { en: "Note", nl: "Notitie", fr: "Note" } },
  { code: "decision", labels: { en: "Decision", nl: "Besluit", fr: "Décision" } },
  { code: "attachment", labels: { en: "Attachment", nl: "Bijlage", fr: "Pièce jointe" } },
  { code: "form", labels: { en: "Form", nl: "Formulier", fr: "Formulaire" } },
  { code: "evidence", labels: { en: "Evidence", nl: "Bewijsstuk", fr: "Preuve" } },
  { code: "contract", labels: { en: "Contract", nl: "Contract", fr: "Contrat" } },
  { code: "report", labels: { en: "Report", nl: "Rapport", fr: "Rapport" } },
];

describe("managed DocumentType seed", () => {
  test("retains the nine owner-authored codes and labels", async () => {
    const catalog = await loadDocumentTypeCatalog();
    expect(catalog).toEqual(catalogEntries);
  });

  test("projects only the localized owner-authored fields", async () => {
    const records = await loadDocumentTypeSeedRecords();
    expect(records).toHaveLength(9);
    expect(records[0]).toEqual({
      code: "incoming_mail",
      name: "Incoming mail",
    });
    for (const record of records) {
      expect(record).not.toHaveProperty("id");
      expect(record).not.toHaveProperty("tenantId");
      expect(record).not.toHaveProperty("description");
      expect(record).not.toHaveProperty("defaultConfidentiality");
      expect(record).not.toHaveProperty("requiresRegistration");
      expect(record).not.toHaveProperty("allowsExternalPublication");
    }
  });

  test("uses only an explicitly supported locale and returns independent values", async () => {
    for (const locale of DOCUMENT_TYPE_SEED_LOCALES) {
      const records = await loadDocumentTypeSeedRecords(locale);
      expect(records.every((record) => record.name.length > 0)).toBe(true);
    }
    expect((await loadDocumentTypeSeedRecords("nl"))[0]?.name).toBe("Inkomende post");
    await expect(loadDocumentTypeSeedRecords("de" as never)).rejects.toThrow(
      "Unsupported DocumentType seed locale",
    );

    const first = await loadDocumentTypeCatalog();
    (first[0]?.labels as { en: string }).en = "Changed by caller";
    expect((await loadDocumentTypeCatalog())[0]?.labels.en).toBe("Incoming mail");
  });
});
