// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  ChevronRight,
  Inbox as InboxIcon,
  MoreHorizontal,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/cn";
import { InputChat, type InputChatProps } from "./input-chat";
import { PickupDialogue, type PickupDialogueProps } from "./pickup-dialogue";
import {
  RecipientTimestamp,
  type RecipientTimestampProps,
} from "./recipient-timestamp";

export const inboxMainFigmaBinding = {
  fileKey: "CbKdajB2p4lAW3bBGcHBYd",
  name: "Inbox \\ Main",
  rootNodeId: "37:38935",
  variants: {
    emptystate: "37:38936",
    message: "37:40139",
    "checked-out": "332:13553",
  },
} as const;

export type InboxMainVariant = "emptystate" | "message" | "checked-out";

export interface InboxMainProps extends Omit<ComponentProps<"div">, "title"> {
  /** Figma `variant` axis for Inbox \ Main. */
  variant?: InboxMainVariant;
  /** Label for the root inbox crumb. */
  inboxLabel?: ReactNode;
  /** Optional href for the root inbox crumb. */
  inboxHref?: string;
  /** Hidden shortcut attached to the inbox icon only. Keeps the normal crumb link unchanged. */
  inboxIconHref?: string | null;
  /** Subject shown in the breadcrumb tail and subject row. */
  subject?: ReactNode;
  /** Optional secondary breadcrumb text, shown in parentheses. */
  breadcrumbMeta?: ReactNode;
  /** Formatted absolute time for the subject row. */
  timestamp?: ReactNode;
  /** Formatted relative time for the subject row. */
  relativeTime?: ReactNode;
  /** Small checked-out actor marker shown before the timestamp in checked-out state. */
  checkedOutIndicator?: ReactNode;
  /** Subject-row actions. Defaults to the Figma overflow action. */
  actions?: ReactNode;
  /** Sender/recipient row rendered below the subject row. */
  recipient?: ReactNode;
  /** Summary block rendered above the email body. */
  summary?: ReactNode;
  /** Main email body content. */
  body?: ReactNode;
  /** Pick-up prompt shown in message state before the composer. */
  pickupPrompt?: ReactNode;
  /** Composer/input area rendered at the bottom. */
  inputChat?: ReactNode;
  /** Backwards-compatible alias for `inputChat`. */
  composer?: ReactNode;
  /** Empty-state content rendered for `emptystate`. */
  emptyState?: ReactNode;
}

export interface InboxMainSummaryProps extends Omit<ComponentProps<"div">, "title"> {
  /** Summary heading. */
  title: ReactNode;
  /** Summary body content. */
  children: ReactNode;
}

function DefaultActions() {
  return (
    <button
      type="button"
      disabled
      aria-label="More actions"
      className="flex size-5 shrink-0 items-center justify-center text-[var(--color-foreground-subtle)] disabled:cursor-not-allowed"
    >
      <MoreHorizontal className="size-5" aria-hidden />
    </button>
  );
}

/**
 * Figma `Inbox \ Main` product component for email conversations.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma name="Inbox \ Main"
 * @figma node-id=37-38935 root
 * @figma node-id=37-38936 variant=emptystate
 * @figma node-id=37-40139 variant=message
 * @figma node-id=332-13553 variant=checked-out
 */
export function InboxMain({
  variant = "emptystate",
  inboxLabel = "Inbox",
  inboxHref,
  inboxIconHref,
  subject,
  breadcrumbMeta,
  timestamp,
  relativeTime,
  checkedOutIndicator,
  actions,
  recipient,
  summary,
  body,
  pickupPrompt,
  inputChat,
  composer,
  emptyState,
  className,
  ...props
}: InboxMainProps) {
  const hasMessage = variant === "message" || variant === "checked-out";
  const resolvedInputChat = inputChat ?? composer;
  const crumbContent = inboxHref ? (
    <a href={inboxHref} className="hover:text-[var(--color-foreground)]">
      {inboxLabel}
    </a>
  ) : (
    inboxLabel
  );

  return (
    <div
      {...props}
      data-slot="inbox-main"
      data-figma-file-key={inboxMainFigmaBinding.fileKey}
      data-figma-name={inboxMainFigmaBinding.name}
      data-figma-root-node-id={inboxMainFigmaBinding.rootNodeId}
      data-figma-node-id={inboxMainFigmaBinding.variants[variant]}
      data-variant={variant}
      className={cn(
        "flex h-full min-h-0 min-w-0 w-full flex-col items-start overflow-hidden bg-[var(--color-card)]",
        hasMessage ? "gap-2" : "gap-[10px]",
        className,
      )}
    >
      <header
        data-slot="inbox-main-breadcrumb"
        data-testid="conversation-detail-header"
        className="flex h-12 w-full shrink-0 items-center gap-1 border-b border-[var(--color-border-muted)] pl-4 pr-2"
      >
        {inboxIconHref ? (
          <a
            href={inboxIconHref}
            aria-label="Open WhatsApp mock simulator"
            className="cursor-default rounded-sm text-[var(--color-foreground-subtle)] outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
          >
            <InboxIcon className="size-4 shrink-0" aria-hidden />
          </a>
        ) : (
          <InboxIcon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" aria-hidden />
        )}
        <span className="shrink-0 font-sans text-[13px] font-semibold leading-[13px] tracking-[-0.39px] text-[var(--color-foreground-subtle)]">
          {crumbContent}
        </span>
        {hasMessage && subject ? (
          <>
            <ChevronRight
              className="size-4 shrink-0 text-[var(--color-foreground-muted)]"
              aria-hidden
            />
            <p className="min-w-0 flex-1 truncate font-sans text-[13px] font-semibold leading-[13px] tracking-[-0.39px] text-[var(--color-foreground-subtle)]">
              <span>{subject}</span>
              {breadcrumbMeta ? (
                <span className="font-normal text-[var(--color-foreground-muted)]">
                  {" "}
                  ({breadcrumbMeta})
                </span>
              ) : null}
            </p>
          </>
        ) : null}
      </header>

      {variant === "emptystate" ? (
        <div
          data-slot="inbox-main-empty-state"
          className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-4 overflow-hidden"
        >
          {emptyState}
        </div>
      ) : (
        <>
          <main
            data-slot="inbox-main-message"
            className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col items-start gap-10 overflow-y-auto overscroll-contain p-4"
          >
            <div
              data-slot="inbox-main-message-header"
              className="flex w-full max-w-[1000px] shrink-0 flex-col items-start gap-6"
            >
              <div
                data-slot="inbox-main-subject-row"
                className={cn(
                  "flex w-full shrink-0 items-center",
                  variant === "checked-out" ? "gap-2" : "gap-4",
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <h1 className="truncate font-sans text-[24px] font-medium leading-[24px] tracking-[-0.72px] text-[var(--color-foreground)]">
                    {subject}
                  </h1>
                </div>
                {variant === "checked-out" && checkedOutIndicator ? (
                  <div className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full">
                    {checkedOutIndicator}
                  </div>
                ) : null}
                {timestamp || relativeTime ? (
                  <div className="flex shrink-0 items-center gap-1 font-sans text-[13px] leading-[13px] tracking-[-0.39px] text-[var(--color-foreground-muted)]">
                    {timestamp ? <span className="font-medium">{timestamp}</span> : null}
                    {relativeTime ? <span className="font-normal">({relativeTime})</span> : null}
                  </div>
                ) : null}
                <div className="flex shrink-0 items-center justify-end gap-[17px]">
                  {actions ?? <DefaultActions />}
                </div>
              </div>

              {recipient}
            </div>

            <div
              data-slot="inbox-main-email-area"
              className="flex w-full max-w-[1000px] shrink-0 flex-col items-start gap-6"
            >
              {summary}
              {body}
              <div className="h-4 w-full shrink-0 pt-0.5" aria-hidden />
            </div>

            {variant === "message" ? pickupPrompt : null}
          </main>

          {resolvedInputChat ? (
            <div
              data-slot="inbox-main-input-row"
              className="flex w-full max-w-[1000px] shrink-0 flex-col items-start justify-end"
            >
              {resolvedInputChat}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export function InboxMainSummary({
  title,
  children,
  className,
  ...props
}: InboxMainSummaryProps) {
  return (
    <div
      data-slot="inbox-main-summary-row"
      className={cn("flex w-full shrink-0 items-start px-4", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1 rounded-[var(--radius-small)] bg-[linear-gradient(90deg,rgba(255,255,255,0.5),rgba(255,255,255,0.5)),linear-gradient(90deg,rgb(237,240,249),rgb(237,240,249))] py-4 pl-4 pr-6 font-sans text-[13px] leading-[22px] tracking-[-0.39px] text-[var(--color-foreground-subtle)]">
        <p className="font-semibold">{title}</p>
        <div className="font-normal">{children}</div>
      </div>
    </div>
  );
}

export function InboxMainRecipient(props: RecipientTimestampProps) {
  return <RecipientTimestamp context="email" {...props} />;
}

export function InboxMainComposerFrame(props: InputChatProps) {
  return <InputChat type="multiline" {...props} />;
}

export function InboxMainPickupPrompt(props: PickupDialogueProps) {
  return <PickupDialogue context="email" {...props} />;
}

export type InboxMainRecipientProps = RecipientTimestampProps;
export type InboxMainComposerFrameProps = InputChatProps;
export type InboxMainPickupPromptProps = PickupDialogueProps;
