// SPDX-License-Identifier: BUSL-1.1
/**
 * The integrations catalog.
 *
 * Hand-written and tracked, unlike the entity pages under `app/(generated)`:
 * this is one fixed screen driven by runtime data, not a page emitted per
 * entity. It sits directly under `app/` because the generated root layout owns
 * the app shell, so a plain route gets the sidebar without a route group.
 *
 * Every row comes from the API's connector catalog. Adding a connector is a
 * YAML and a package — nothing here changes, which is the property the whole
 * page exists to demonstrate.
 */
import Link from "next/link";
import { BodyHeader } from "@/components/ui/layout/body-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/display/card";
import { Badge } from "@/components/ui/display/badge";
import { listConnectors } from "@/actions/integrations";
import {
  ConnectorStatusBadge,
  STATUS_HINT,
} from "@/features/integrations/connector-status";
import { getActiveLang, t } from "@/lib/server-context";

export const metadata = { title: "Integrations" };

export default async function IntegrationsPage() {
  const lang = await getActiveLang();
  const connectors = await listConnectors();

  return (
    <div className="space-y-6 p-6">
      <BodyHeader
        showBackButton={false}
        title={lang === "nl" ? "Integraties" : "Integrations"}
        subtitle={
          lang === "nl"
            ? "Koppelingen met externe systemen, en de inloggegevens die ze gebruiken."
            : "Connections to external systems, and the credentials they use."
        }
      />

      {connectors.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {lang === "nl"
              ? "Deze omgeving levert geen integraties."
              : "This deployment ships no integrations."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {connectors.map((connector) => {
            const hint = t(STATUS_HINT[connector.status], lang);
            const configured = connector.installations.length;
            return (
              <Link
                key={connector.slug}
                href={`/integrations/${connector.slug}`}
                className="focus-ring rounded-[var(--radius-field)]"
              >
                <Card className="h-full transition-colors hover:border-foreground/20">
                  <CardHeader className="flex flex-row items-start justify-between gap-3">
                    <CardTitle>{connector.title}</CardTitle>
                    <ConnectorStatusBadge status={connector.status} lang={lang} />
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {hint ? (
                      <p className="text-sm text-muted-foreground">{hint}</p>
                    ) : null}
                    <div className="flex flex-wrap gap-1.5">
                      {connector.category ? (
                        <Badge variant="outline">{connector.category}</Badge>
                      ) : null}
                      {configured > 0 ? (
                        <Badge variant="secondary">
                          {configured}{" "}
                          {lang === "nl"
                            ? configured === 1 ? "installatie" : "installaties"
                            : configured === 1 ? "installation" : "installations"}
                        </Badge>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
