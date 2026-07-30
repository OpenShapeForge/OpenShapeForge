// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";
import { cn } from "../lib/cn";
import { editorLineVariants } from "./editor-line-variants";

export type FormeditorLineProps = Omit<React.ComponentProps<"button">, "type"> & {
  /** Figma Battery `state` variant. */
  state?: "active" | "hover" | "expanded";
  label: React.ReactNode;
  trailing?: React.ReactNode;
};

/**
 * @figma node-id=61-4452 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=61-4452
 * @figma node-id=61-4453 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=61-4453
 * @figma node-id=61-4276 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=61-4276
 * @figma node-id=61-4604 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=61-4604
 */
export function FormeditorLine({
  label,
  trailing,
  className,
  state,
  ...props
}: FormeditorLineProps) {
  return (
    <button
      type="button"
      data-slot="editor-line"
      data-editor="form"
      className={cn(editorLineVariants({ editor: "form", state }), className)}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </button>
  );
}
