// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@openshapeforge/ui";

export interface TableBulkActionBarProps {
  selectedCount: number;
  onClearSelection: () => void;
  children: ReactNode;
}

export function TableBulkActionBar({
  selectedCount,
  onClearSelection,
  children,
}: TableBulkActionBarProps) {
  if (selectedCount <= 0) return null;

  return (
    <div className="sticky bottom-0 z-30 bg-background border-t shadow-lg px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">
          {selectedCount} geselecteerd
        </span>
        <Button variant="ghost" size="sm" onClick={onClearSelection}>
          <X className="mr-1 size-3" />
          Deselecteren
        </Button>
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
