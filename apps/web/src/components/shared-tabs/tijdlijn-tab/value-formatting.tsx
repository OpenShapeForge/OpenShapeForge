// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import type { FieldChange } from "@/lib/timeline-types";

const FIELD_LABELS: Record<string, string> = {
  achternaam: "Achternaam",
  voorletters: "Voorletters",
  voornamen: "Voornamen",
  tussenvoegsel: "Tussenvoegsel",
  geboortedatum: "Geboortedatum",
  geslacht: "Geslacht",
  nationaliteit: "Nationaliteit",
  burgerservicenummer: "BSN",
  soort: "Soort",
  naam: "Naam",
  handelsnaam: "Handelsnaam",
  kvkNummer: "KvK-nummer",
  emailadres: "E-mailadres",
  telefoonnummer: "Telefoonnummer",
  adres: "Adres",
  postcode: "Postcode",
  plaatsnaam: "Plaatsnaam",
  status: "Status",
  begindatum: "Begindatum",
  einddatum: "Einddatum",
  omschrijving: "Omschrijving",
  prioriteit: "Prioriteit",
  actief: "Actief",
  code: "Code",
  toelichting: "Toelichting",
  displayName: "Weergavenaam",
  relationType: "Relatietype",
  relationSubType: "Relatiesubtype",
  preferredContactChannel: "Voorkeurskanaal",
  externalId: "Externe id",
  externalCode: "Externe code",
};

function normalizeRefValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.code === "string") return obj.code;
  }
  return String(value);
}

function isNoOpChange(fc: FieldChange): boolean {
  if (fc.old === null || fc.old === undefined) return false;
  return normalizeRefValue(fc.old) === normalizeRefValue(fc.new);
}

export function filterMeaningfulChanges(
  fieldChanges: FieldChange[],
): FieldChange[] {
  return fieldChanges.filter((fc) => !isNoOpChange(fc));
}

export function fieldToLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  return field
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

export function formatValueNode(value: unknown): ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/50">&mdash;</span>;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.naam === "string" && obj.naam) return obj.naam;
    if (typeof obj.code === "string") return obj.code;
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "Ja" : "Nee";
  if (typeof value === "number") return value.toLocaleString("nl-NL");
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}(T[\d:.Z+\-]*)?$/.test(value)) {
      try {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) {
          return d.toLocaleDateString("nl-NL", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          });
        }
      } catch {
        // Not a date.
      }
    }
    if (value.length > 80) return `${value.slice(0, 77)}...`;
    return value;
  }
  return String(value);
}

export function buildChangeSummary(fieldChanges: FieldChange[]): string {
  const labels = fieldChanges.map((fc) => fieldToLabel(fc.field));
  if (labels.length === 0) return "";
  if (labels.length === 1) return `${labels[0]} gewijzigd`;
  if (labels.length <= 3) return `${labels.join(", ")} gewijzigd`;
  return `${labels.slice(0, 2).join(", ")} en ${labels.length - 2} andere velden gewijzigd`;
}

export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("nl-NL", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
