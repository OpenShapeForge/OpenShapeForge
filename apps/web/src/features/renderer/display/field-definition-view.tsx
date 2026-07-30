// SPDX-License-Identifier: BUSL-1.1
import { TextDisplay } from "@/features/renderer/display/text-display";
import { translateRendererText } from "@/features/renderer/runtime/field-utils";
import { isRecord } from "@/lib/json-record";

type FieldDefinitionViewProps = {
  value: unknown;
  lang?: string;
};

type NormalizedFieldDefinition = {
  label: string;
  key: string;
  type: string;
  required: boolean | null;
  semanticType: string;
  description: string;
};

function readString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function readLocalizedString(value: unknown, lang: string) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (isRecord(value)) {
    return translateRendererText(value as Record<string, string>, lang);
  }
  return "";
}

function readRequired(record: Record<string, unknown>) {
  if (typeof record.required === "boolean") return record.required;
  const validation = record.validation;
  if (isRecord(validation)) {
    const required = validation.required;
    if (typeof required === "boolean") return required;
    if (isRecord(required) && typeof required.value === "boolean") {
      return required.value;
    }
  }
  return null;
}

function normalizeFieldDefinition(
  value: unknown,
  lang: string,
): NormalizedFieldDefinition | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return {
      label: lang === "nl" ? "Variabele bron" : "Variable source",
      key: value.trim(),
      type: "fieldDefinition[]",
      required: null,
      semanticType: "",
      description: "",
    };
  }

  if (!isRecord(value)) return null;

  const kind = readString(value, "kind");
  const source = readString(value, "source");
  if (kind === "variable" && source) {
    return {
      label: lang === "nl" ? "Variabele bron" : "Variable source",
      key: source,
      type: "fieldDefinition[]",
      required: null,
      semanticType: "",
      description: "",
    };
  }

  const key = readString(value, "key", "name", "id");
  const label =
    readLocalizedString(value.label, lang) ||
    readString(value, "label", "title", "name") ||
    key ||
    "-";

  return {
    label,
    key: key || "-",
    type: readString(value, "valueType", "type", "fieldType") || "-",
    required: readRequired(value),
    semanticType: readString(value, "semanticType", "semanticTypeKey"),
    description: readLocalizedString(value.description, lang) || readString(value, "description"),
  };
}

function normalizeFieldDefinitions(value: unknown, lang: string) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeFieldDefinition(entry, lang))
      .filter((entry): entry is NormalizedFieldDefinition => Boolean(entry));
  }

  const single = normalizeFieldDefinition(value, lang);
  return single ? [single] : [];
}

function yesNo(value: boolean | null, lang: string) {
  if (value === null) return "-";
  return lang === "nl" ? (value ? "Ja" : "Nee") : (value ? "Yes" : "No");
}

export function FieldDefinitionView({ value, lang = "nl" }: FieldDefinitionViewProps) {
  const rows = normalizeFieldDefinitions(value, lang);

  if (rows.length === 0) {
    return <TextDisplay className="text-muted-foreground">-</TextDisplay>;
  }

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-[11px] font-semibold uppercase text-muted-foreground">
            <th className="pt-0 pb-2 pr-4">{lang === "nl" ? "Label" : "Label"}</th>
            <th className="pt-0 pb-2 pr-4">{lang === "nl" ? "Sleutel" : "Key"}</th>
            <th className="pt-0 pb-2 pr-4">{lang === "nl" ? "Type" : "Type"}</th>
            <th className="pt-0 pb-2 pr-4">{lang === "nl" ? "Verplicht" : "Required"}</th>
            <th className="pt-0 pb-2 pr-4">{lang === "nl" ? "Semantiek" : "Semantic"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={`${row.key}-${index}`}
              className="border-b last:border-b-0"
            >
              <td className="max-w-[260px] py-2 pr-4 align-top font-medium text-foreground">
                <div>{row.label}</div>
                {row.description ? (
                  <div className="mt-1 line-clamp-2 text-xs font-normal text-muted-foreground">
                    {row.description}
                  </div>
                ) : null}
              </td>
              <td className="max-w-[240px] py-2 pr-4 align-top font-mono text-xs text-muted-foreground">
                <span className="break-all">{row.key}</span>
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">{row.type}</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                {yesNo(row.required, lang)}
              </td>
              <td className="max-w-[220px] py-2 pr-4 align-top font-mono text-xs text-muted-foreground">
                <span className="break-all">{row.semanticType || "-"}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
