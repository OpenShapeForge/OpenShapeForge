// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@openshapeforge/ui";
import { cn } from "@/lib/utils";

export interface TableErrorBannerProps {
  children: ReactNode;
  onRetry?: () => void;
  className?: string;
}

/**
 * Dismissible-style banner rendered above a table when the list fails to load.
 * Use the destructive token palette so dark mode and theming stay consistent.
 */
export function TableErrorBanner({
  children,
  onRetry,
  className,
}: TableErrorBannerProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900",
        className,
      )}
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-700" aria-hidden="true" />
      <div className="flex-1">{children}</div>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="border-red-300 text-red-900 hover:bg-red-100"
        >
          Opnieuw proberen
        </Button>
      ) : null}
    </div>
  );
}
