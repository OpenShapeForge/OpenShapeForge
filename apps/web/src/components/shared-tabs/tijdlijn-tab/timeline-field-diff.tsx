// SPDX-License-Identifier: BUSL-1.1
import type { FieldChange } from "@/lib/timeline-types";
import {
  fieldToLabel,
  filterMeaningfulChanges,
  formatValueNode,
} from "./value-formatting";

/**
 * Field diff shown when an event row is expanded. Rendered as a definition
 * grid with three semantic columns (Veld / Vorige waarde / Nieuwe waarde)
 * using `<div>`s; this content has no sort/filter/pagination behavior.
 */
export function TimelineFieldDiff({
  fieldChanges,
}: {
  fieldChanges: FieldChange[];
}) {
  const filtered = filterMeaningfulChanges(fieldChanges);
  if (filtered.length === 0) {
    return (
      <div className="border-t border-border bg-muted/20 px-6 py-4 text-xs text-muted-foreground">
        Geen veldwijzigingen om te tonen.
      </div>
    );
  }

  return (
    <div className="border-t border-border bg-muted/20 px-6 py-4">
      <div className="rounded-md border bg-background">
        <div
          className="grid grid-cols-[30%_35%_35%] border-b border-muted px-3 py-2 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"
          aria-hidden="true"
        >
          <div>Veld</div>
          <div>Vorige waarde</div>
          <div>Nieuwe waarde</div>
        </div>
        <dl className="divide-y divide-muted/50 text-xs">
          {filtered.map((fc) => (
            <div
              key={fc.field}
              className="grid grid-cols-[30%_35%_35%] items-baseline px-3 py-1.5"
            >
              <dt className="pr-3 font-medium text-foreground">
                {fieldToLabel(fc.field)}
              </dt>
              <dd className="pr-3 text-muted-foreground line-through">
                {formatValueNode(fc.old)}
              </dd>
              <dd className="font-medium text-green-700 dark:text-green-400">
                {formatValueNode(fc.new)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
