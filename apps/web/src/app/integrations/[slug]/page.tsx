// SPDX-License-Identifier: BUSL-1.1
/**
 * One integration: its licence terms, and its installations.
 *
 * What this page offers follows from `status`, and the two unavailable statuses
 * are answered differently on purpose. NOT_LICENSED shows the licence block —
 * an operator seeing a connector they cannot use should learn what it would
 * take to use it. NOT_INSTALLED says the package is missing, which is somebody
 * else's job and not a form this operator can fill.
 */
import { notFound } from "next/navigation";
import { BodyHeader } from "@/components/ui/layout/body-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/display/card";
import { getConnector } from "@/actions/integrations";
import {
  ConnectorStatusBadge,
  STATUS_HINT,
} from "@/features/integrations/connector-status";
import { InstallationPanel } from "@/features/integrations/installation-panel";
import { isConfigurable, type ConnectorInstallation } from "@/features/integrations/types";
import { getActiveLang, t } from "@/lib/server-context";

/**
 * The form an unconfigured connector shows.
 *
 * A connector with no installation still needs somewhere to type, so the page
 * synthesises an empty one rather than hiding the form behind an "add" button
 * that every first-time operator would have to find. It is marked
 * `persisted: false`, which is what withholds Enable and Test connection —
 * neither means anything before a save.
 */
function blankInstallation(instanceKey: string): ConnectorInstallation {
  return {
    instanceKey,
    displayName: null,
    enabled: false,
    configuration: {},
    contract: {
      state: "CURRENT",
      missingRequiredFields: [],
      removedFields: [],
      reason: null,
      requiresReverification: false,
    },
  };
}

export default async function IntegrationDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const lang = await getActiveLang();
  const connector = await getConnector(slug);
  if (!connector) notFound();

  const hint = t(STATUS_HINT[connector.status], lang);
  const configurable = isConfigurable(connector.status);
  const installations =
    connector.installations.length > 0
      ? connector.installations
      : [blankInstallation("default")];

  return (
    <div className="space-y-6 p-6">
      <BodyHeader
        title={
          <span className="flex items-center gap-2">
            {connector.title}
            <ConnectorStatusBadge status={connector.status} lang={lang} />
          </span>
        }
        subtitle={hint || undefined}
        backFallbackHref="/integrations"
        breadcrumbs={[
          { href: "/integrations", label: lang === "nl" ? "Integraties" : "Integrations" },
        ]}
      />

      {connector.status === "NOT_LICENSED" ? (
        <Card>
          <CardHeader>
            <CardTitle>{lang === "nl" ? "Licentie" : "Licence"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>{connector.license.spdx}</p>
            {connector.license.notice ? <p>{connector.license.notice}</p> : null}
            {connector.license.url ? (
              <a className="text-primary underline-offset-4 hover:underline" href={connector.license.url}>
                {connector.license.url}
              </a>
            ) : null}
            {connector.requiredEntitlement ? (
              <p>
                {lang === "nl" ? "Vereist recht: " : "Requires entitlement: "}
                <code>{connector.requiredEntitlement}</code>
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {configurable ? (
        <div className="space-y-4">
          {installations.map((installation) => (
            <InstallationPanel
              key={installation.instanceKey}
              connector={connector}
              installation={installation}
              lang={lang}
              persisted={connector.installations.length > 0}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
