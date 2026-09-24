// SPDX-License-Identifier: BUSL-1.1
import { BodyHeader } from "@/components/ui/layout/body-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/display/card";
import { getCachedSession } from "@/lib/cached-session";
import { type FieldValueType, tryFieldValueType } from "@/lib/field-contract/field-v2";
import { buildGatewayUrl } from "@/lib/server/gateway";
import { submitPendingConfiguration } from "./actions";

export const metadata = { title: "Secure configuration" };
export const dynamic = "force-dynamic";

type FieldDefinition = {
  key?: unknown;
  label?: unknown;
  description?: unknown;
  osfType?: unknown;
  required?: unknown;
  classification?: { sensitivity?: unknown };
  options?: { items?: { value?: unknown; label?: unknown }[] };
};

type PendingConfiguration = {
  id: string;
  displayName: string;
  messagePrefix?: string;
  definitions: FieldDefinition[];
};

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const localized = value as Record<string, unknown>;
    if (typeof localized.nl === "string") return localized.nl;
    if (typeof localized.en === "string") return localized.en;
    const first = Object.values(localized).find(
      (candidate) => typeof candidate === "string",
    );
    if (typeof first === "string") return first;
  }
  return "";
}

/**
 * Stored definitions name their type as `osfType`; the input control follows
 * its base type, the way the runtime's own configuration form does.
 */
function baseType(field: FieldDefinition) {
  return tryFieldValueType({
    key: typeof field.key === "string" ? field.key : "(unnamed)",
    osfType: typeof field.osfType === "string" ? field.osfType : "",
  });
}

function inputType(field: FieldDefinition, base: FieldValueType): string {
  if (
    field.classification?.sensitivity === "confidential" ||
    field.classification?.sensitivity === "pii" ||
    field.classification?.sensitivity === "bsn"
  ) {
    return "password";
  }
  if (base === "integer" || base === "number") {
    return "number";
  }
  return "text";
}

async function loadPending(): Promise<PendingConfiguration | null> {
  const session = await getCachedSession();
  if (!session?.accessToken) return null;
  const response = await fetch(
    buildGatewayUrl("/api/entity-configuration/pending"),
    {
      cache: "no-store",
      headers: { authorization: `Bearer ${session.accessToken}` },
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("The secure configuration service is unavailable.");
  return (await response.json()) as PendingConfiguration;
}

export default async function ConfigurationPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const query = await searchParams;
  if (query.saved === "1") {
    return (
      <div className="space-y-6 p-6">
        <BodyHeader showBackButton={false} title="Configuratie opgeslagen" />
        <Card>
          <CardContent className="text-sm">
            Je kunt dit venster sluiten en teruggaan naar je gesprek.
          </CardContent>
        </Card>
      </div>
    );
  }

  const pending = await loadPending();
  const hasUnsupportedFields = pending?.definitions.some((field) => !baseType(field).ok) ?? false;
  if (pending && hasUnsupportedFields) {
    console.error("Secure configuration contains an unsupported field contract.", {
      fields: pending.definitions
        .filter((field) => !baseType(field).ok)
        .map((field) => ({ key: field.key, osfType: field.osfType })),
    });
  }
  return (
    <div className="space-y-6 p-6">
      <BodyHeader
        showBackButton={false}
        title="Veilige configuratie"
        subtitle="Deze waarden gaan rechtstreeks naar de veilige configuratieservice en niet via het model."
      />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>{pending?.displayName ?? "Geen openstaande configuratie"}</CardTitle>
        </CardHeader>
        <CardContent>
          {!pending ? (
            <p className="text-sm text-muted-foreground">
              Er staat voor jouw account geen configuratie klaar. Start opnieuw vanuit je gesprek.
            </p>
          ) : (
            <form action={hasUnsupportedFields ? undefined : submitPendingConfiguration} className="space-y-5">
              <input type="hidden" name="handoffId" value={pending.id} />
              {pending.messagePrefix ? (
                <p className="rounded-lg border bg-muted/40 p-3 text-sm">
                  {pending.messagePrefix}
                </p>
              ) : null}
              {query.error ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  Opslaan is niet gelukt. Controleer de waarden en probeer opnieuw.
                </p>
              ) : null}
              {pending.definitions.map((field) => {
                const key = typeof field.key === "string" ? field.key : "";
                if (!key) return null;
                const label = text(field.label) || key;
                const description = text(field.description);
                const options = field.options?.items ?? [];
                const required = field.required === true;
                const resolution = baseType(field);
                if (!resolution.ok) {
                  return (
                    <div key={key} role="alert" data-unsupported-field={key} className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                      <span className="font-medium">{label}</span>
                      <span className="mt-1 block">Dit veld gebruikt een niet-ondersteund contract en kan niet worden ingevuld.</span>
                    </div>
                  );
                }
                const base = resolution.value;
                if (base === "boolean") {
                  return (
                    <label key={key} className="flex items-start gap-3 text-sm">
                      <input type="checkbox" name={key} className="mt-1" />
                      <span><span className="font-medium">{label}</span>{description ? <span className="block text-muted-foreground">{description}</span> : null}</span>
                    </label>
                  );
                }
                return (
                  <label key={key} className="block space-y-1.5 text-sm">
                    <span className="font-medium">{label}{required ? " *" : ""}</span>
                    {options.length > 0 ? (
                      <select name={key} required={required} className="w-full rounded-lg border bg-background px-3 py-2">
                        <option value="">Selecteer…</option>
                        {options.map((option, index) => (
                          <option key={`${key}-${index}`} value={String(option.value ?? "")}>
                            {text(option.label) || String(option.value ?? "")}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={inputType(field, base)}
                        name={key}
                        required={required}
                        step={base === "integer" ? "1" : base === "number" ? "any" : undefined}
                        autoComplete="off"
                        className="w-full rounded-lg border bg-background px-3 py-2"
                      />
                    )}
                    {description ? <span className="block text-muted-foreground">{description}</span> : null}
                  </label>
                );
              })}
              {hasUnsupportedFields ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
                  Opslaan is geblokkeerd om te voorkomen dat configuratie verloren gaat. Neem contact op met de beheerder.
                </p>
              ) : null}
              <button type={hasUnsupportedFields ? "button" : "submit"} disabled={hasUnsupportedFields} className="rounded-lg bg-action-primary px-4 py-2 text-sm font-medium text-action-primary-foreground hover:bg-action-primary-hover disabled:cursor-not-allowed disabled:opacity-50">
                Veilig opslaan
              </button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
