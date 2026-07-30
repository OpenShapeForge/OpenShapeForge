// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/display/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/overlay/popover";
import {
  evaluateLabels,
  type LabelRule,
} from "@/features/labels/lib/label-evaluator";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link";

const VALID_VARIANTS = new Set<BadgeVariant>([
  "default",
  "secondary",
  "destructive",
  "outline",
  "ghost",
  "link",
]);

function toBadgeVariant(variant: string): BadgeVariant {
  return VALID_VARIANTS.has(variant as BadgeVariant)
    ? (variant as BadgeVariant)
    : "default";
}

export function EntityLabels({
  rules,
  entityData,
}: {
  rules: LabelRule[];
  entityData: Record<string, unknown>;
}) {
  const labels = useMemo(
    () => evaluateLabels(rules, entityData),
    [rules, entityData],
  );

  if (labels.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {labels.map((label) => (
        <Popover key={label.id}>
          <PopoverTrigger asChild>
            <Badge
              variant={toBadgeVariant(label.variant)}
              className="cursor-pointer"
            >
              {label.label}
            </Badge>
          </PopoverTrigger>
          {label.description ? (
            <PopoverContent>
              <p className="text-sm">{label.description}</p>
            </PopoverContent>
          ) : null}
        </Popover>
      ))}
    </div>
  );
}
