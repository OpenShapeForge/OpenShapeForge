// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Maximize, Minus, Plus } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * Floating viewport control: zoom-out, live zoom percentage, zoom-in, and
 * fit-view. Pure visual primitive — wire the buttons to your viewport
 * library (xyflow, deck.gl, etc.) at the call site.
 *
 * @figma viewport-control — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=45-3630
 *
 * Icon mapping: Figma `Minus` → lucide `Minus`, Figma `Plus` → lucide `Plus`,
 * Figma `CornersOut` → lucide `Maximize`.
 */
export interface ViewportControlProps {
  /** Current zoom factor (1 = 100%). */
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  /** Accessible label for the surrounding group. Defaults to "Zoom and view". */
  ariaLabel?: string;
  /** Accessible label for the zoom-out button. Defaults to "Zoom out". */
  zoomOutLabel?: string;
  /** Accessible label for the zoom-in button. Defaults to "Zoom in". */
  zoomInLabel?: string;
  /** Accessible label for the fit-view button. Defaults to "Fit view". */
  fitViewLabel?: string;
  className?: string;
}

const cellClass =
  "flex items-center justify-center rounded-[var(--radius-extrasmall)] bg-background p-1 text-foreground-subtle transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

export function ViewportControl({
  zoom,
  onZoomIn,
  onZoomOut,
  onFitView,
  ariaLabel = "Zoom and view",
  zoomOutLabel = "Zoom out",
  zoomInLabel = "Zoom in",
  fitViewLabel = "Fit view",
  className,
}: ViewportControlProps) {
  const displayZoom = Math.round(zoom * 100);

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-[var(--radius-extrasmall)]",
        className,
      )}
    >
      <button
        type="button"
        onClick={onZoomOut}
        aria-label={zoomOutLabel}
        title={zoomOutLabel}
        className={cellClass}
      >
        <Minus className="size-4" aria-hidden="true" />
      </button>
      <span
        className="flex items-center justify-center rounded-[var(--radius-extrasmall)] bg-background px-2 py-1 font-sans text-[12px] font-normal leading-[12px] tracking-[-0.36px] text-foreground-subtle"
        aria-live="polite"
      >
        {displayZoom}%
      </span>
      <button
        type="button"
        onClick={onZoomIn}
        aria-label={zoomInLabel}
        title={zoomInLabel}
        className={cellClass}
      >
        <Plus className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onFitView}
        aria-label={fitViewLabel}
        title={fitViewLabel}
        className={cellClass}
      >
        <Maximize className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
