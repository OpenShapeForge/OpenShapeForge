// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  Building2,
  House,
  Signature,
  UserRound,
  UsersRound,
} from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../lib/cn";
import { Avatar } from "./avatar";

export type EntityHeaderKind =
  | "unit"
  | "contract"
  | "organisation"
  | "household"
  | "person";

export type EntityHeaderType = EntityHeaderKind;
export type EntityHeaderState = "active" | "compact";
export type EntityHeaderSize = "M" | "S";

export interface EntityHeaderProps
  extends Omit<ComponentPropsWithoutRef<"div">, "role" | "title" | "type"> {
  /** Figma `type` axis; controls the default icon and avatar treatment. */
  type?: EntityHeaderType;
  /** Backwards-compatible alias for the Figma `type` axis. */
  kind?: EntityHeaderKind;
  /** Figma `state` axis. */
  state?: EntityHeaderState;
  /** Figma `variant` property, kept as an open string for library variants. */
  variant?: string;
  /** Figma size axis: `M` for the selected unit, `S` for compact relation rows. */
  size?: EntityHeaderSize;
  /** Primary entity label. */
  title: ReactNode;
  /** Figma role line. For app data, bind this to an actual role field. */
  role?: ReactNode;
  /** Backwards-compatible secondary line; used only when `role` is not supplied. */
  subtitle?: ReactNode;
  /** Optional image URL for unit, organisation, and person avatars. */
  imageSrc?: string;
  /** Alt text for the image avatar. */
  imageAlt?: string;
  /** Initials for non-image avatars, e.g. "PG". */
  initials?: string;
  /** Override the default leading icon for icon-tile kinds. */
  icon?: ReactNode;
  /** Metadata chips rendered below the unit subtitle. */
  tags?: ReactNode;
  /** Figma `personas` slot override when the design supplies a ready-made identity row. */
  personas?: ReactNode;
  /** Figma `show-name-and-roll` property. */
  showNameAndRoll?: boolean;
  /** Clean alias for Figma `show-name-and-roll`. */
  showNameAndRole?: boolean;
  /** Figma `show-role` property. */
  showRole?: boolean;
  /** Backwards-compatible alias for hiding the role/subtitle line. */
  showSubtitle?: boolean;
  /** Figma `show-tags` property. */
  showTags?: boolean;
}

interface EntityHeaderIdentityMarkProps {
  kind: EntityHeaderKind;
  size: EntityHeaderSize;
  imageSrc?: string;
  imageAlt?: string;
  initials?: string;
  icon?: ReactNode;
}

function fallbackIcon(kind: EntityHeaderKind) {
  switch (kind) {
    case "contract":
      return <Signature aria-hidden="true" />;
    case "organisation":
      return <Building2 aria-hidden="true" />;
    case "household":
      return <UsersRound aria-hidden="true" />;
    case "person":
      return <UserRound aria-hidden="true" />;
    case "unit":
      return <House aria-hidden="true" />;
  }
}

function EntityHeaderIdentityMark({
  kind,
  size,
  imageSrc,
  imageAlt,
  initials,
  icon,
}: EntityHeaderIdentityMarkProps) {
  const isMedium = size === "M";
  const markSize = isMedium ? "size-16" : "size-6";

  if (imageSrc) {
    const rounded =
      kind === "person"
        ? "rounded-full"
        : "rounded-[var(--radius-extrasmall)]";
    return (
      <img
        src={imageSrc}
        alt={imageAlt ?? ""}
        className={cn(markSize, "shrink-0 object-cover", rounded)}
      />
    );
  }

  if (kind === "unit") {
    return (
      <div
        aria-hidden="true"
        className={cn(
          markSize,
          "flex shrink-0 items-center justify-center rounded-[var(--radius-small)] bg-[var(--color-brand-indigo-20)] text-[var(--color-brand-indigo-120)] [&_svg]:size-6",
        )}
      >
        {icon ?? fallbackIcon(kind)}
      </div>
    );
  }

  if (kind === "household" || initials) {
    return (
      <Avatar
        variant={kind === "organisation" ? "avatar-square-initial" : "avatar-circle-initial"}
        initials={initials}
        className={cn(markSize, "text-[12px] leading-[12px]")}
      />
    );
  }

  return (
    <Avatar
      variant="icon"
      className={cn(
        markSize,
        "text-[var(--color-foreground-subtle)] [&_svg]:size-4",
      )}
    >
      {icon ?? fallbackIcon(kind)}
    </Avatar>
  );
}

/**
 * Figma `entity-header` identity row for unit and compact relation records.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma name="entity-header"
 * @figma node-id=650-23253
 * @figma node-id=650-23267
 * @figma node-id=650-23269
 * @figma node-id=650-23266
 * @figma node-id=650-23270
 */
export function EntityHeader({
  type,
  kind,
  state,
  variant,
  size,
  title,
  role,
  subtitle,
  imageSrc,
  imageAlt,
  initials,
  icon,
  tags,
  personas,
  showNameAndRoll,
  showNameAndRole = true,
  showRole = true,
  showSubtitle = true,
  showTags = true,
  className,
  ...props
}: EntityHeaderProps) {
  const resolvedKind = type ?? kind ?? "unit";
  const resolvedSize = size ?? (resolvedKind === "unit" ? "M" : "S");
  const resolvedState = state ?? (resolvedSize === "M" ? "active" : "compact");
  const isMedium = resolvedSize === "M";
  const secondaryLine = role ?? subtitle;
  const shouldShowNameAndRole = showNameAndRoll ?? showNameAndRole;
  const shouldShowSecondaryLine = showRole && showSubtitle && Boolean(secondaryLine);
  const shouldShowTags = showTags && Boolean(tags);

  return (
    <div
      data-slot="entity-header"
      data-type={resolvedKind}
      data-kind={resolvedKind}
      data-state={resolvedState}
      data-variant={variant}
      data-size={resolvedSize}
      data-show-role={showRole ? "true" : "false"}
      data-show-name-and-roll={shouldShowNameAndRole ? "true" : "false"}
      data-show-tags={showTags ? "true" : "false"}
      className={cn(
        "flex min-w-0 items-center",
        isMedium ? "h-20 gap-4 px-2 py-2" : "h-10 gap-2 px-2 py-1",
        className,
      )}
      {...props}
    >
      {personas ? (
        personas
      ) : (
        <EntityHeaderIdentityMark
          kind={resolvedKind}
          size={resolvedSize}
          imageSrc={imageSrc}
          imageAlt={imageAlt}
          initials={initials}
          icon={icon}
        />
      )}
      {shouldShowNameAndRole ? (
        <div
          className={cn(
            "flex min-w-0 flex-col justify-center",
            isMedium ? "translate-y-[1.5px] gap-1" : "gap-0",
          )}
        >
          <p
            className={cn(
              "min-w-0 truncate font-sans font-medium text-[var(--color-foreground)]",
              isMedium
                ? "text-[15px] leading-[15px]"
                : "text-[13px] leading-[13px]",
            )}
          >
            {title}
          </p>
          {shouldShowSecondaryLine ? (
            <p
              className={cn(
                "min-w-0 truncate font-sans font-normal text-[var(--color-foreground-subtle)]",
                isMedium ? "text-[12px] leading-[12px]" : "text-[13px] leading-[13px]",
              )}
            >
              {secondaryLine}
            </p>
          ) : null}
          {shouldShowTags ? (
            <div className="mt-2 flex min-w-0 max-w-full flex-nowrap items-center gap-1 overflow-hidden">
              {tags}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
