// SPDX-License-Identifier: BUSL-1.1
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/cn";
import { Avatar, type AvatarProps } from "./avatar";

export const recipientTimestampFigmaBinding = {
  fileKey: "CbKdajB2p4lAW3bBGcHBYd",
  name: "Recipient & Timestamp",
  nodes: {
    chatMessage: "318:7656",
    chatCheckedOut: "344:14886",
    emailMessage: "323:8184",
    emailCheckedOut: "332:13580",
  },
} as const;

export interface RecipientTimestampProps extends ComponentProps<"div"> {
  /** Primary sender/recipient name. */
  name: ReactNode;
  /** Secondary email, phone number, or descriptor. */
  address?: ReactNode;
  /** Initials shown when no custom avatar is provided. */
  initials?: string;
  /** Optional fully custom avatar. */
  avatar?: ReactNode;
  /** Avatar variant for the default avatar. */
  avatarVariant?: AvatarProps["variant"];
  /** Optional class for the default avatar element. */
  avatarClassName?: string;
  /** Figma root that owns this instance. */
  context?: "chat" | "email";
  /** Top-level Figma variant for node binding. */
  variant?: "message" | "checked-out";
}

/**
 * Figma `Recipient & Timestamp` row.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma name="Recipient & Timestamp"
 * @figma node-id=318-7656 context=chat,variant=message
 * @figma node-id=344-14886 context=chat,variant=checked-out
 * @figma node-id=323-8184 context=email,variant=message
 * @figma node-id=332-13580 context=email,variant=checked-out
 */
export function RecipientTimestamp({
  name,
  address,
  initials,
  avatar,
  avatarVariant = "avatar-circle-initial",
  avatarClassName,
  context = "email",
  variant = "message",
  className,
  ...props
}: RecipientTimestampProps) {
  const nodeKey = `${context}${variant === "checked-out" ? "CheckedOut" : "Message"}` as
    | "chatMessage"
    | "chatCheckedOut"
    | "emailMessage"
    | "emailCheckedOut";

  return (
    <div
      data-slot="recipient-timestamp"
      data-figma-file-key={recipientTimestampFigmaBinding.fileKey}
      data-figma-name={recipientTimestampFigmaBinding.name}
      data-figma-node-id={recipientTimestampFigmaBinding.nodes[nodeKey]}
      data-context={context}
      data-variant={variant}
      className={cn("flex w-full items-start justify-between", className)}
      {...props}
    >
      <div className="flex shrink-0 items-center gap-3">
        {avatar ?? (
          <Avatar
            variant={avatarVariant}
            initials={initials}
            className={cn(
              "size-10 bg-[var(--color-brand-smartblue-20)] text-[var(--color-brand-smartblue-100)]",
              avatarClassName,
            )}
          />
        )}
        <div className="flex shrink-0 flex-col items-start gap-1 font-sans text-[13px] leading-[13px] tracking-[-0.39px]">
          <p className="min-w-full font-semibold text-[var(--color-foreground-subtle)]">
            {name}
          </p>
          {address ? (
            <p className="font-medium text-[var(--color-foreground-muted)]">{address}</p>
          ) : null}
        </div>
      </div>
      <div className="h-[13px] w-[124px] shrink-0" aria-hidden />
    </div>
  );
}
