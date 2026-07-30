// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Mic, Plus, Smile } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/cn";

export const inputChatFigmaBinding = {
  fileKey: "CbKdajB2p4lAW3bBGcHBYd",
  name: "input-chat",
  nodes: {
    singleLineActive: "326:6595",
    singleLineDisabled: "327:6651",
    multiLineActive: "333:6677",
    multiLineDisabled: "333:6667",
  },
} as const;

export type InputChatState = "active" | "disabled";
export type InputChatType = "single-line" | "multi-line" | "multiline";

export interface InputChatProps extends Omit<ComponentProps<"div">, "children"> {
  /** Figma `state` axis. */
  state?: InputChatState;
  /** Figma `type` axis where present. */
  type?: InputChatType;
  /** Placeholder, draft text, or an editable input/textarea supplied by the product app. */
  children?: ReactNode;
  /** Content well class, usually used by consumers to set textarea height. */
  contentClassName?: string;
  /** Override the left action icons. */
  leftActions?: ReactNode;
  /** Optional right-side action, for example the email send button. */
  trailing?: ReactNode;
}

function DefaultActions({ className }: { className?: string }) {
  return (
    <div className={cn("flex shrink-0 items-center gap-4 p-2", className)}>
      <Plus className="size-6" aria-hidden />
      <Mic className="size-6" aria-hidden />
      <Smile className="size-6" aria-hidden />
    </div>
  );
}

/**
 * Figma `input-chat` component used by Chat \ Main and Inbox \ Main.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma name="input-chat"
 * @figma node-id=327-6650 component-set
 * @figma node-id=326-6595 state=active,type=single-line
 * @figma node-id=327-6651 state=disabled,type=single-line
 * @figma node-id=333-6677 state=active,type=multi-line
 * @figma node-id=333-6667 state=disabled,type=multi-line
 */
export function InputChat({
  state = "active",
  type = "single-line",
  children,
  contentClassName,
  leftActions,
  trailing,
  className,
  ...props
}: InputChatProps) {
  const isDisabled = state === "disabled";
  const normalizedType = type === "multiline" ? "multi-line" : type;
  const textColor = "text-[var(--color-foreground-subtle)]";

  if (normalizedType === "single-line") {
    return (
      <div
        data-slot="input-chat"
        data-figma-file-key={inputChatFigmaBinding.fileKey}
        data-figma-name={inputChatFigmaBinding.name}
        data-figma-node-id={
          isDisabled
            ? inputChatFigmaBinding.nodes.singleLineDisabled
            : inputChatFigmaBinding.nodes.singleLineActive
        }
        data-state={state}
        data-type={normalizedType}
        className={cn(
          "flex w-full items-center gap-2 bg-[var(--color-card)] px-4 py-2",
          className,
        )}
        {...props}
      >
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2 overflow-hidden rounded-[var(--radius-extralarge)] bg-[var(--color-surface)] p-3">
          <div
            className={cn(
              "flex min-h-[15px] min-w-0 flex-1 flex-col justify-center font-sans text-[15px] font-normal leading-[15px] tracking-[-0.45px]",
              textColor,
              contentClassName,
            )}
          >
            {children}
          </div>
          <Smile className={cn("size-6 shrink-0", textColor)} aria-hidden />
        </div>
        <div className={cn("flex shrink-0 items-center gap-2", textColor)}>
          {leftActions ?? (
            <>
              <Plus className="size-6" aria-hidden />
              <Mic className="size-6" aria-hidden />
            </>
          )}
          {trailing}
        </div>
      </div>
    );
  }

  return (
    <div
      data-slot="input-chat"
      data-figma-file-key={inputChatFigmaBinding.fileKey}
      data-figma-name={inputChatFigmaBinding.name}
      data-figma-node-id={
        isDisabled
          ? inputChatFigmaBinding.nodes.multiLineDisabled
          : inputChatFigmaBinding.nodes.multiLineActive
      }
      data-state={state}
      data-type={normalizedType}
      className={cn(
        "flex w-full flex-col items-start justify-center gap-2 bg-[var(--color-card)] px-4 py-2",
        className,
      )}
      {...props}
    >
      <div className="flex w-full shrink-0 items-start overflow-hidden rounded-[var(--radius-extralarge)] bg-[var(--color-surface)] p-3">
        <div
          className={cn(
            "min-h-[15px] flex-1 font-sans text-[15px] font-normal leading-[24px] tracking-[-0.45px]",
            textColor,
            contentClassName,
          )}
        >
          {children}
        </div>
      </div>
      <div className="flex w-full shrink-0 items-center justify-between">
        <div className={textColor}>
          {leftActions ?? <DefaultActions />}
        </div>
        {trailing}
      </div>
    </div>
  );
}
