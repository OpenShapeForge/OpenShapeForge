// SPDX-License-Identifier: BUSL-1.1
import { BodyHeader } from "@/components/ui/layout/body-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/display/card";
import { getCachedSession } from "@/lib/cached-session";
import { buildGatewayUrl } from "@/lib/server/gateway";
import { submitPendingConfiguration } from "./actions";

export const metadata = { title: "Secure configuration" };
export const dynamic = "force-dynamic";

type FieldDefinition = {
  key?: unknown;
  label?: unknown;
  description?: unknown;
  valueType?: unknown;
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

function inputType(field: FieldDefinition): string {
  if (
    field.classification?.sensitivity === "confidential" ||
    field.classification?.sensitivity === "pii" ||
    field.classification?.sensitivity === "bsn"
  ) {
    return "password";
  }
  if (field.valueType === "integer" || field.valueType === "number") {
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
  return (
    <div className="space-y-6 p-6">
      <BodyHeader
        showBackButton={false}
        title="Veilige configuratie"
        subtitle="Deze waarden gaan rechtstreeks naar KERN en niet via het model."
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
            <form action={submitPendingConfiguration} className="space-y-5">
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
                if (field.valueType === "boolean") {
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
                        type={inputType(field)}
                        name={key}
                        required={required}
                        step={field.valueType === "integer" ? "1" : field.valueType === "number" ? "any" : undefined}
                        autoComplete="off"
                        className="w-full rounded-lg border bg-background px-3 py-2"
                      />
                    )}
                    {description ? <span className="block text-muted-foreground">{description}</span> : null}
                  </label>
                );
              })}
              <button type="submit" className="rounded-lg bg-action-primary px-4 py-2 text-sm font-medium text-action-primary-foreground hover:bg-action-primary-hover">
                Veilig opslaan
              </button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
