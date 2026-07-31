// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/cn";

const messagesVariants = cva(
  "flex w-full min-w-0 items-center gap-3 rounded-[var(--radius-small)] border border-border-subtle bg-card px-3 py-2 text-left transition-colors",
  {
    variants: {
      variant: {
        chat: "",
        whatsapp: "",
        mail: "",
        ai: "",
      },
      state: {
        active: "",
        hover: "hover:bg-muted/40",
      },
      type: {
        library: "",
      },
    },
    defaultVariants: {
      variant: "chat",
      state: "active",
      type: "library",
    },
  },
);

export type MessagesProps = Omit<React.ComponentProps<"div">, "title"> &
  VariantProps<typeof messagesVariants> & {
    leading?: React.ReactNode;
    /** Primary line (replaces the native `title` tooltip attribute — use `aria-label` / `Tooltip` for hints). */
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    /** Right-aligned metadata (time, counts) without squeezing the title block. */
    trailing?: React.ReactNode;
    connectorLeft?: boolean;
    connectorRight?: boolean;
    /**
     * When true, the row is a standalone control (`role="button"`, `tabIndex={0}`).
     * Keep false when the row is wrapped by a link or other interactive parent.
     */
    interactive?: boolean;
  };

/**
 * Battery `messages` list row — inbox-style preview line.
 *
 * @figma node-id=93-3087 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=93-3087
 * @figma node-id=93-3088 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=93-3088
 * @figma node-id=93-3095 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=93-3095
 * @figma node-id=131-4378 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=131-4378
 * @figma node-id=131-4387 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=131-4387
 * @figma node-id=131-4396 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=131-4396
 * @figma node-id=131-4405 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=131-4405
 * @figma node-id=131-4414 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=131-4414
 * @figma node-id=131-4423 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=131-4423
 */
export function Messages({
  className,
  variant,
  state,
  type,
  leading,
  title,
  subtitle,
  trailing,
  connectorLeft,
  connectorRight,
  interactive = false,
  ...props
}: MessagesProps) {
  return (
    <div
      data-slot="messages"
      data-connector-left={connectorLeft ? "true" : undefined}
      data-connector-right={connectorRight ? "true" : undefined}
      className={cn(messagesVariants({ variant, state, type }), className)}
      {...(interactive ? { role: "button" as const, tabIndex: 0 as const } : {})}
      {...props}
    >
      {connectorLeft ? (
        <span aria-hidden className="w-px shrink-0 self-stretch bg-border-subtle" />
      ) : null}
      {leading ? <span className="shrink-0">{leading}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[13px] font-medium leading-[13px] tracking-[-0.39px] text-foreground-subtle">
          {title}
        </span>
        {subtitle ? (
          <span className="mt-1 block truncate font-sans text-[12px] font-normal leading-[12px] tracking-[-0.36px] text-foreground-muted">
            {subtitle}
          </span>
        ) : null}
      </span>
      {trailing ? (
        <span className="ml-2 flex shrink-0 flex-col items-end gap-1 self-center text-right">
          {trailing}
        </span>
      ) : null}
      {connectorRight ? (
        <span aria-hidden className="w-px shrink-0 self-stretch bg-border-subtle" />
      ) : null}
    </div>
  );
}

export { messagesVariants };
