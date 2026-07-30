// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  ChevronRight,
  Inbox as InboxIcon,
  MoreHorizontal,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/cn";

export const chatMainFigmaBinding = {
  fileKey: "CbKdajB2p4lAW3bBGcHBYd",
  name: "Chat \\ Main",
  rootNodeId: "318:7613",
  variants: {
    emptystate: "318:7614",
    message: "318:7629",
    "checked-out": "344:14859",
  },
} as const;

export const chatBubbleFigmaBinding = {
  fileKey: "CbKdajB2p4lAW3bBGcHBYd",
  name: "chat-bubble",
  nodes: {
    outSingleLine: "326:6603",
    outMultiLine: "326:6612",
    inMultiLine: "326:6621",
    inSingleLine: "326:6630",
  },
} as const;

export type ChatMainVariant = "emptystate" | "message" | "checked-out";

export interface ChatMainProps extends Omit<ComponentProps<"div">, "title"> {
  /** Figma `variant` axis for Chat \ Main. */
  variant?: ChatMainVariant;
  inboxLabel?: ReactNode;
  inboxHref?: string;
  /** Hidden shortcut attached to the inbox icon only. Keeps the normal crumb link unchanged. */
  inboxIconHref?: string | null;
  subject?: ReactNode;
  breadcrumbMeta?: ReactNode;
  timestamp?: ReactNode;
  relativeTime?: ReactNode;
  checkedOutIndicator?: ReactNode;
  actions?: ReactNode;
  recipient?: ReactNode;
  body?: ReactNode;
  pickupPrompt?: ReactNode;
  inputChat?: ReactNode;
  emptyState?: ReactNode;
}

export type ChatBubbleDirection = "inbound" | "outbound";
export type ChatBubbleType = "in" | "out";
export type ChatBubbleVariant = "single-line" | "multi-line";
export type ChatBubbleTone = "customer" | "operator" | "system" | "internal";

export interface ChatBubbleProps extends ComponentProps<"div"> {
  direction?: ChatBubbleDirection;
  /** Figma `type` axis. Prefer `direction` for product semantics. */
  type?: ChatBubbleType;
  /** Figma `variant` axis. */
  variant?: ChatBubbleVariant;
  tone?: ChatBubbleTone;
  timestamp?: ReactNode;
  status?: ReactNode;
  tail?: boolean;
}

function deliveryStatusMeta(status: ReactNode) {
  if (typeof status !== "string") return null;
  switch (status) {
    case "pending":
      return { glyph: "...", label: "Sending" };
    case "sent":
      return { glyph: "v", label: "Sent" };
    case "delivered":
      return { glyph: "vv", label: "Delivered" };
    case "read":
      return { glyph: "vv", label: "Read" };
    case "failed":
      return { glyph: "!", label: "Failed" };
    default:
      return null;
  }
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
 * Figma `Chat \ Main` product component for chat/WhatsApp conversations.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma name="Chat \ Main"
 * @figma node-id=318-7613 root
 * @figma node-id=318-7614 variant=emptystate
 * @figma node-id=318-7629 variant=message
 * @figma node-id=344-14859 variant=checked-out
 */
export function ChatMain({
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
  body,
  pickupPrompt,
  inputChat,
  emptyState,
  className,
  ...props
}: ChatMainProps) {
  const hasMessage = variant === "message" || variant === "checked-out";
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
      data-slot="chat-main"
      data-figma-file-key={chatMainFigmaBinding.fileKey}
      data-figma-name={chatMainFigmaBinding.name}
      data-figma-root-node-id={chatMainFigmaBinding.rootNodeId}
      data-figma-node-id={chatMainFigmaBinding.variants[variant]}
      data-variant={variant}
      className={cn(
        "flex h-full min-h-0 min-w-0 w-full flex-col items-start overflow-hidden bg-[var(--color-card)]",
        hasMessage ? "gap-2" : "gap-[10px]",
        className,
      )}
    >
      <header
        data-slot="chat-main-breadcrumb"
        data-testid="conversation-detail-header"
        className="flex h-12 w-full shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] pl-4 pr-2"
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
          data-slot="chat-main-empty-state"
          className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-4 overflow-hidden"
        >
          {emptyState}
        </div>
      ) : (
        <>
          <main
            data-slot="chat-main-message"
            className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col items-start gap-10 overflow-y-auto overscroll-contain"
          >
            <div
              data-slot="chat-main-header"
              className="flex w-full max-w-[1000px] shrink-0 flex-col items-start gap-6 p-4"
            >
              <div
                data-slot="chat-main-subject-row"
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
              data-slot="chat-main-chat-area"
              className="flex w-full max-w-[1000px] shrink-0 flex-col items-start gap-6"
            >
              <div className="flex w-full flex-col gap-6 p-4">
                {body}
                <div className="h-4 w-full shrink-0 pt-0.5" aria-hidden />
              </div>
              {variant === "message" ? pickupPrompt : null}
            </div>
          </main>

          {inputChat ? (
            <div
              data-slot="chat-main-input-row"
              className="flex w-full max-w-[1000px] shrink-0 flex-col items-start justify-end"
            >
              {inputChat}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Figma chat-bubble row inside `Chat \ Main`.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma name="chat-bubble"
 * @figma node-id=326-6602 component-set
 * @figma node-id=326-6603 type=out,variant=single-line
 * @figma node-id=326-6612 type=out,variant=multi-line
 * @figma node-id=326-6621 type=in,variant=multi-line
 * @figma node-id=326-6630 type=in,variant=single-line
 */
export function ChatBubble({
  direction,
  type,
  variant = "multi-line",
  tone,
  timestamp,
  status,
  tail,
  className,
  children,
  ...props
}: ChatBubbleProps) {
  const resolvedDirection =
    direction ?? (type === "out" ? "outbound" : "inbound");
  const resolvedType = type ?? (resolvedDirection === "outbound" ? "out" : "in");
  const isInbound = resolvedDirection === "inbound";
  const resolvedTone = tone ?? (isInbound ? "customer" : "operator");
  const resolvedTail = tail ?? isInbound;
  const hasDarkSurface = resolvedTone === "operator";
  const delivery = deliveryStatusMeta(status);
  const nodeKey = `${resolvedType}-${variant}` as const;
  const figmaNodeId =
    nodeKey === "out-single-line"
      ? chatBubbleFigmaBinding.nodes.outSingleLine
      : nodeKey === "out-multi-line"
        ? chatBubbleFigmaBinding.nodes.outMultiLine
        : nodeKey === "in-single-line"
          ? chatBubbleFigmaBinding.nodes.inSingleLine
          : chatBubbleFigmaBinding.nodes.inMultiLine;

  return (
    <div
      data-slot="chat-row"
      data-direction={resolvedDirection}
      data-type={resolvedType}
      data-variant={variant}
      className={cn("flex w-full px-2", isInbound ? "justify-start" : "justify-end")}
    >
      <div
        {...props}
        data-slot="chat-bubble"
        data-figma-file-key={chatBubbleFigmaBinding.fileKey}
        data-figma-name={chatBubbleFigmaBinding.name}
        data-figma-node-id={figmaNodeId}
        data-tone={resolvedTone}
        className={cn(
          "relative flex max-w-[647px] shrink-0 flex-col gap-2 rounded-b-[8px] p-3 font-sans text-[13px] font-normal leading-[22px] tracking-[-0.39px]",
          isInbound ? "rounded-tl-[8px]" : "rounded-tr-[8px]",
          resolvedTone === "customer" &&
            "bg-[var(--color-background)] text-[var(--color-foreground-subtle)]",
          resolvedTone === "operator" &&
            "bg-[var(--color-brand-indigo-100)] text-[var(--color-white)]",
          resolvedTone === "system" &&
            "bg-[var(--color-functional-orange-10)] text-[var(--color-foreground-subtle)]",
          resolvedTone === "internal" &&
            "bg-[var(--color-brand-indigo-20)] text-[var(--color-foreground-subtle)]",
          className,
        )}
      >
        <div className="whitespace-pre-wrap">{children}</div>
        {timestamp || status ? (
          <div
            className={cn(
              "flex items-center justify-end gap-2 text-[12px] leading-[12px] tracking-[-0.36px]",
              hasDarkSurface
                ? "text-[var(--color-white)]"
                : "text-[var(--color-foreground-subtle)]",
            )}
          >
            {timestamp ? <span>{timestamp}</span> : null}
            {delivery ? (
              <span
                aria-label={delivery.label}
                title={delivery.label}
                className={cn(
                  "font-semibold",
                  status === "read" && !hasDarkSurface
                    ? "text-[var(--color-brand-smartblue-100)]"
                    : null,
                )}
              >
                {delivery.glyph}
              </span>
            ) : status ? (
              <span>{status}</span>
            ) : null}
          </div>
        ) : null}
        {resolvedTail && isInbound ? (
          <span
            aria-hidden
            className="absolute left-[-8px] top-0 h-[13px] w-[8px] bg-[var(--color-background)]"
            style={{
              clipPath: "polygon(100% 0, 100% 100%, 0 0)",
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
