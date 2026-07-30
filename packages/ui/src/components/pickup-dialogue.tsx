// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/cn";
import { Button } from "./button";

export const pickupDialogueFigmaBinding = {
  fileKey: "CbKdajB2p4lAW3bBGcHBYd",
  name: "pickup-dialogue",
  nodes: {
    chat: "329:13456",
    email: "329:13492",
  },
} as const;

export interface PickupDialogueProps extends ComponentProps<"div"> {
  /** Button label. */
  buttonLabel: ReactNode;
  /** Instruction text beside the button. */
  children: ReactNode;
  /** Optional shortcut hint inside the button. */
  shortcut?: ReactNode;
  /** Optional form action wrapper for server actions. */
  action?: ComponentProps<"form">["action"];
  /** Hidden input pairs submitted with `action`. */
  hiddenInputs?: Array<{ name: string; value: string }>;
  /** Figma root that owns this instance. */
  context?: "chat" | "email";
}

/**
 * Figma `pickup-dialogue` used before an operator checks out a conversation.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma name="pickup-dialogue"
 * @figma node-id=329-13456 context=chat
 * @figma node-id=329-13492 context=email
 */
export function PickupDialogue({
  buttonLabel,
  shortcut,
  action,
  hiddenInputs,
  children,
  context = "email",
  className,
  ...props
}: PickupDialogueProps) {
  const button = (
    <Button
      type={action ? "submit" : "button"}
      className="h-[37px] rounded-[var(--radius-small)] px-2 py-3 font-sans text-[13px] font-medium leading-[13px] tracking-[-0.39px]"
    >
      {buttonLabel}
      {shortcut ? (
        <span className="font-normal leading-[13px]">{shortcut}</span>
      ) : null}
    </Button>
  );

  return (
    <div
      data-slot="pickup-dialogue"
      data-figma-file-key={pickupDialogueFigmaBinding.fileKey}
      data-figma-name={pickupDialogueFigmaBinding.name}
      data-figma-node-id={pickupDialogueFigmaBinding.nodes[context]}
      data-context={context}
      className={cn(
        "flex w-full max-w-[1000px] shrink-0 items-center justify-center gap-2 rounded-[var(--radius-extralarge)]",
        className,
      )}
      {...props}
    >
      {action ? (
        <form action={action}>
          {hiddenInputs?.map((input) => (
            <input key={input.name} type="hidden" name={input.name} value={input.value} />
          ))}
          {button}
        </form>
      ) : (
        button
      )}
      <div className="flex shrink-0 items-start">
        <p className="font-sans text-[13px] font-normal leading-[13px] tracking-[-0.39px] text-[var(--color-foreground-muted)]">
          {children}
        </p>
      </div>
    </div>
  );
}
