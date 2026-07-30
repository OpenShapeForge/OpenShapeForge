// SPDX-License-Identifier: BUSL-1.1
import { Clock, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/display/badge";
import type { TimelineEvent } from "@/lib/timeline-types";
import { cn } from "@/lib/utils";
import {
  ACTIE_ICON_TONES,
  ACTIE_ICONS,
  DOMAIN_COLORS,
} from "./timeline-styles";
import {
  buildChangeSummary,
  filterMeaningfulChanges,
  formatTimestamp,
} from "./value-formatting";

export function MomentCell({ event }: { event: TimelineEvent }) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
      <Clock className="size-3 shrink-0" />
      <span>{formatTimestamp(event.timestamp)}</span>
    </div>
  );
}

export function ActivityCell({ event }: { event: TimelineEvent }) {
  const actieIcon = ACTIE_ICONS[event.actie] ?? <Pencil className="size-3" />;
  const actieIconTone =
    ACTIE_ICON_TONES[event.actie] ??
    "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
  const fieldChanges = event.metadata?.fieldChanges;
  const hasFieldChanges =
    Array.isArray(fieldChanges) && fieldChanges.length > 0;
  const meaningfulChanges = hasFieldChanges
    ? filterMeaningfulChanges(fieldChanges)
    : [];

  const displayTitle =
    hasFieldChanges && meaningfulChanges.length > 0
      ? buildChangeSummary(meaningfulChanges)
      : event.titel;

  return (
    <div className="flex min-w-0 items-start gap-2">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded",
          actieIconTone,
        )}
        title={event.actie}
      >
        {actieIcon}
      </span>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          {displayTitle}
        </div>
        {event.omschrijving ? (
          <div className="truncate text-xs text-muted-foreground">
            {event.omschrijving}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ActorCell({ event }: { event: TimelineEvent }) {
  const actor = event.actor;
  if (!actor) return <span className="text-muted-foreground">&mdash;</span>;

  if (actor.type === "bron") {
    return (
      <span className="text-xs text-muted-foreground">
        {actor.sourceLabel ?? actor.displayName}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-foreground">{actor.displayName}</span>
      {actor.roleLabel ? (
        <Badge
          variant="secondary"
          className="px-1.5 py-0 text-[10px] font-normal"
        >
          {actor.roleLabel}
        </Badge>
      ) : null}
    </div>
  );
}

export function DomainCell({ event }: { event: TimelineEvent }) {
  const domainColor =
    DOMAIN_COLORS[event.categorie] ?? "bg-muted text-muted-foreground";
  return (
    <Badge variant="secondary" className={cn("text-xs", domainColor)}>
      {event.categorie}
    </Badge>
  );
}
