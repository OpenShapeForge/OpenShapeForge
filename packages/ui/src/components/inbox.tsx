// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Mail, MessageCircle, MessagesSquare } from "lucide-react";

import { cn } from "../lib/cn";
import { CategoryShowMore } from "./category-show-more";
import { Messages, type MessagesProps } from "./messages";
import { RowSectionheader, type RowSectionheaderProps } from "./row-sectionheader";

export type InboxProps = ComponentPropsWithoutRef<"div">;

export type InboxSectionProps = ComponentPropsWithoutRef<"section"> &
  Pick<RowSectionheaderProps, "label" | "trailing"> & {
    /** Stack of `InboxList` rows rendered below the section header. */
    children?: ReactNode;
  };

export type InboxListProps = ComponentPropsWithoutRef<"div">;

export type InboxMessageIconType = "messaging" | "whatsapp" | "mail" | "agent";

export type InboxMessageIconProps = ComponentPropsWithoutRef<"span"> & {
  /** Figma `message-icon` type. */
  type?: InboxMessageIconType;
};

export type InboxMessageProps = Omit<MessagesProps, "leading" | "variant"> & {
  /** Figma `message-icon` type rendered as the leading tile. */
  iconType?: InboxMessageIconType;
};

function WhatsappLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

function iconBackground(type: InboxMessageIconType) {
  if (type === "mail") {
    return "var(--color-brand-smartblue-100)";
  }
  if (type === "agent") {
    return "var(--color-brand-amethyst-80)";
  }
  return "var(--color-brand-aquamarine-80)";
}

function iconVariant(type: InboxMessageIconType): MessagesProps["variant"] {
  if (type === "mail") {
    return "mail";
  }
  if (type === "whatsapp") {
    return "whatsapp";
  }
  return "chat";
}

/**
 * Battery `inbox` — composed inbox list with section headers, message rows and
 * category show-more rows.
 *
 * @figma node-id=94-4249 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=94-4249
 */
export function Inbox({ className, ...props }: InboxProps) {
  return (
    <div
      data-slot="inbox"
      className={cn("flex w-full min-w-0 flex-col items-start pb-10", className)}
      {...props}
    />
  );
}

export function InboxSection({
  label,
  trailing,
  className,
  children,
  ...props
}: InboxSectionProps) {
  return (
    <section
      data-slot="inbox-section"
      className={cn("w-full min-w-0", className)}
      {...props}
    >
      <RowSectionheader label={label} trailing={trailing} />
      {children}
    </section>
  );
}

export function InboxList({ className, ...props }: InboxListProps) {
  return (
    <div
      data-slot="inbox-list"
      className={cn("flex w-full min-w-0 flex-col gap-1 px-3 py-2", className)}
      {...props}
    />
  );
}

export function InboxMessageIcon({
  type = "messaging",
  className,
  style,
  ...props
}: InboxMessageIconProps) {
  const Icon =
    type === "mail"
      ? Mail
      : type === "whatsapp"
        ? WhatsappLogo
        : type === "agent"
          ? MessageCircle
          : MessagesSquare;

  return (
    <span
      data-slot="inbox-message-icon"
      data-type={type}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-small)] text-white",
        className,
      )}
      style={{ backgroundColor: iconBackground(type), ...style }}
      {...props}
    >
      <Icon className="size-4" strokeWidth={2} />
    </span>
  );
}

export function InboxMessage({
  iconType = "messaging",
  className,
  state = "active",
  ...props
}: InboxMessageProps) {
  return (
    <Messages
      data-slot="inbox-message"
      variant={iconVariant(iconType)}
      state={state}
      leading={<InboxMessageIcon type={iconType} />}
      className={cn("border-0 shadow-none", className)}
      {...props}
    />
  );
}

export { CategoryShowMore as InboxCategoryShowMore };
