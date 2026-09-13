// SPDX-License-Identifier: BUSL-1.1
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

export const DOCUMENT_TYPE_SEED_LOCALES = ["en", "nl", "fr"] as const;

export type DocumentTypeSeedLocale = (typeof DOCUMENT_TYPE_SEED_LOCALES)[number];

export type DocumentTypeCatalogEntry = Readonly<{
  code: string;
  labels: Readonly<Record<DocumentTypeSeedLocale, string>>;
}>;

export type DocumentTypeSeedRecord = Readonly<{
  code: string;
  name: string;
}>;

type DocumentTypeCatalog = Readonly<{
  version: 1;
  types: readonly DocumentTypeCatalogEntry[];
}>;

const CATALOG_URL = new URL("./document-types.seed.yaml", import.meta.url);
const CODE = /^[a-z][a-z0-9_]{0,99}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`DocumentType seed ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !expected.has(key));
  if (unexpected) throw new Error(`DocumentType seed ${label} has unknown field ${unexpected}.`);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new Error(`DocumentType seed ${label} is missing field ${missing}.`);
}

function parseCatalog(source: string): DocumentTypeCatalog {
  const root = object(parseYaml(source), "catalog");
  exactKeys(root, ["version", "types"], "catalog");
  if (root.version !== 1) throw new Error("DocumentType seed version must be 1.");

  if (!Array.isArray(root.types) || root.types.length === 0) {
    throw new Error("DocumentType seed types must be a non-empty array.");
  }
  const codes = new Set<string>();
  const types = root.types.map((raw, index) => {
    const entry = object(raw, `types[${index}]`);
    exactKeys(entry, ["code", "labels"], `types[${index}]`);
    if (typeof entry.code !== "string" || !CODE.test(entry.code) || codes.has(entry.code)) {
      throw new Error(`DocumentType seed types[${index}].code is invalid or duplicated.`);
    }
    codes.add(entry.code);
    const labels = object(entry.labels, `types[${index}].labels`);
    exactKeys(labels, DOCUMENT_TYPE_SEED_LOCALES, `types[${index}].labels`);
    for (const locale of DOCUMENT_TYPE_SEED_LOCALES) {
      const label = labels[locale];
      if (typeof label !== "string" || label.trim() === "" || label.length > 200) {
        throw new Error(`DocumentType seed types[${index}].labels.${locale} is invalid.`);
      }
    }
    return {
      code: entry.code,
      labels: {
        en: labels.en as string,
        nl: labels.nl as string,
        fr: labels.fr as string,
      },
    } satisfies DocumentTypeCatalogEntry;
  });

  return {
    version: 1,
    types,
  };
}

/** Read and validate the package-owned initial DocumentType catalog. */
export async function loadDocumentTypeCatalog(): Promise<readonly DocumentTypeCatalogEntry[]> {
  const catalog = parseCatalog(await readFile(CATALOG_URL, "utf8"));
  return catalog.types.map((entry) => ({ ...entry, labels: { ...entry.labels } }));
}

/**
 * Initial managed records for a host tenant. IDs and tenant identity are
 * intentionally absent: the host inserts with its trusted tenant and lets the
 * database mint IDs, using `(tenant_id, code) DO NOTHING` for idempotency.
 */
export async function loadDocumentTypeSeedRecords(
  locale: DocumentTypeSeedLocale = "en",
): Promise<readonly DocumentTypeSeedRecord[]> {
  if (!DOCUMENT_TYPE_SEED_LOCALES.includes(locale)) {
    throw new Error(`Unsupported DocumentType seed locale: ${String(locale)}.`);
  }
  const catalog = parseCatalog(await readFile(CATALOG_URL, "utf8"));
  return catalog.types.map((entry) => ({
    code: entry.code,
    name: entry.labels[locale],
  }));
}
