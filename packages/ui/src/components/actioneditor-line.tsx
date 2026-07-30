// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";
import { cn } from "../lib/cn";
import { editorLineVariants } from "./editor-line-variants";

export type ActioneditorLineProps = Omit<React.ComponentProps<"button">, "type"> & {
  /** Figma Battery `state` variant. */
  state?: "active" | "hover" | "expanded";
  label: React.ReactNode;
  trailing?: React.ReactNode;
};

/**
 * @figma node-id=64-5564 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5564
 * @figma node-id=64-5565 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5565
 * @figma node-id=64-5573 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5573
 * @figma node-id=64-5582 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5582
 */
export function ActioneditorLine({
  label,
  trailing,
  className,
  state,
  ...props
}: ActioneditorLineProps) {
  return (
    <button
      type="button"
      data-slot="editor-line"
      data-editor="action"
      className={cn(editorLineVariants({ editor: "action", state }), className)}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </button>
  );
}
