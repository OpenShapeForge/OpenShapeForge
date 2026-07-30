// SPDX-License-Identifier: BUSL-1.1
import { Card, CardContent, CardHeader } from "@/components/ui/display/card";
import { TijdlijnTab } from "@/components/shared-tabs/tijdlijn-tab";
import type { RendererFormGroup } from "@/features/renderer/form-definition";
import type { GroupRenderContext } from "./types";
import { getGroupTitle } from "./helpers";

/**
 * Maps entity query names to timeline entity URI prefixes.
 * The timeline service indexes events by entity URI — this mapping
 * bridges from the compiler entity model to those URIs.
 */
const TIMELINE_ENTITY_URI_PREFIXES: Record<string, string> = {
  case: "platform:case",
  relation: "platform:relation",
};

function renderTimelineGroup(
  ctx: GroupRenderContext,
  group: RendererFormGroup,
) {
  const entityId = ctx.structuredValues.id as string | undefined;
  const queryName = ctx.definition.metadata?.queryName as string | undefined;

  if (!entityId || !queryName) {
    return null;
  }

  const prefix = TIMELINE_ENTITY_URI_PREFIXES[queryName];

  if (!prefix) {
    return null;
  }

  const entityUri = `${prefix}/${entityId}`;
  const include = group.timeline?.include
    ?.flatMap((entry) =>
      entry === "self" || typeof entry?.relationship !== "string"
        ? []
        : [{ relationship: entry.relationship }],
    );

  return (
    <TijdlijnTab
      key={`${group.id}-timeline`}
      entityUri={entityUri}
      include={include && include.length > 0 ? include : undefined}
    />
  );
}

export function renderCustomGroup(
  ctx: GroupRenderContext,
  group: RendererFormGroup,
) {
  if (!group.render) {
    return null;
  }

  if (group.render === "timeline") {
    return renderTimelineGroup(ctx, group);
  }

  return (
    <Card key={`${group.id}-custom`}>
      <CardHeader>
        <h2 className="text-lg font-medium">
          {getGroupTitle(group, ctx.lang) || group.id}
        </h2>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {ctx.lang === "nl"
            ? `Aangepaste renderer '${group.render}' is nog niet geïmplementeerd in de web-client.`
            : `Custom renderer '${group.render}' is not implemented in the web client.`}
        </p>
      </CardContent>
    </Card>
  );
}
