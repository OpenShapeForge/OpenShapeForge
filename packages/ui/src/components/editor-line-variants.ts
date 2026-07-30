// SPDX-License-Identifier: BUSL-1.1
import { cva } from "class-variance-authority";

export const editorLineVariants = cva(
  "flex w-full min-w-0 items-center gap-2 border-b border-border-subtle px-0.5 py-3 text-left font-sans text-[13px] font-medium leading-[13px] tracking-[-0.39px] text-foreground-subtle transition-colors",
  {
    variants: {
      editor: {
        action: "bg-transparent",
        form: "bg-transparent",
      },
      state: {
        active: "",
        hover: "hover:bg-muted/40",
        expanded: "bg-muted/30",
      },
    },
    defaultVariants: {
      editor: "action",
      state: "active",
    },
  },
);
