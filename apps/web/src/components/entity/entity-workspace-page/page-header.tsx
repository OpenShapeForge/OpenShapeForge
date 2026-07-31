// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/display/badge";
import { BodyHeader } from "@/components/ui/layout/body-header";
import { EntityRealtimeRefresh } from "@/components/entity/EntityRealtimeRefresh";
import { Button } from "@openshapeforge/ui";
import { t } from "@/lib/server-context";
import type { EntityManifestEntry } from "@/compiler/entity-manifest";
import type { RealtimeResourceKey } from "@/features/realtime/lib/resource-keys";
import type { PageAction } from "./types";

export function buildPageHeader({
  entry,
  config,
  lang,
  workspaceTitle,
  pageActions,
  realtimeRefresh,
}: {
  entry: EntityManifestEntry;
  config: any;
  lang: string;
  workspaceTitle: string;
  pageActions: PageAction[] | undefined;
  realtimeRefresh: ReactNode;
}) {
  return (
    <div className="space-y-4">
      {realtimeRefresh}
      <BodyHeader
        title={workspaceTitle}
        subtitle={config.subtitle ? t(config.subtitle, lang) : undefined}
        showBackButton={false}
      />
      {entry.domains.length ? (
        <div className="flex flex-wrap gap-2">
          {entry.domains.map((domain) => (
            <Badge key={domain} variant="secondary">
              {domain}
            </Badge>
          ))}
        </div>
      ) : null}
      {pageActions?.length ? (
        <div className="flex flex-wrap gap-3">
          {pageActions.filter((action) => Boolean(action.href)).map((action) => (
            <Button key={action.key} asChild variant="outline" data-testid={`entity-action-${action.key}`}>
              <Link href={action.href!}>{action.label}</Link>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function buildRealtimeRefresh({
  realtimeResourceKeys,
  detailHeaderTitle,
  workspaceTitle,
}: {
  realtimeResourceKeys: RealtimeResourceKey[];
  detailHeaderTitle: unknown;
  workspaceTitle: string;
}) {
  return (
    <EntityRealtimeRefresh
      resourceKeys={realtimeResourceKeys}
      toastLabel={typeof detailHeaderTitle === "string"
        ? detailHeaderTitle
        : workspaceTitle}
    />
  );
}
