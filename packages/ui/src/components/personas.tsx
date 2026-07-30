// SPDX-License-Identifier: BUSL-1.1
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { Avatar, type AvatarProps } from "./avatar";

export const personasFigmaBinding = {
  fileKey: "CbKdajB2p4lAW3bBGcHBYd",
  name: "Personas",
  nodeId: "37:35380",
} as const;

export interface PersonasProps extends Omit<ComponentProps<"div">, "role"> {
  /** Primary person or actor name. */
  name: ReactNode;
  /** Secondary role, email address, or descriptor shown below the name. */
  role?: ReactNode;
  /** Avatar variant used for the leading identity mark. */
  avatarVariant?: AvatarProps["variant"];
  /** 1-2 character initials for initial avatar variants. */
  initials?: string;
  /** Image URL for image avatar variants. */
  src?: string;
  /** Alt text for image avatar variants. */
  alt?: string;
  /** Show the name/role text next to the avatar. Default true. */
  showNameAndRole?: boolean;
  /** Show the secondary role line. Default true. */
  showRole?: boolean;
  /** Optional class for the nested avatar element. */
  avatarClassName?: string;
}

/**
 * Personas row — Figma Battery person identity pattern.
 *
 * Used where a compact person/sender identity is needed: avatar, primary name,
 * and optional secondary role/email text.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma name="Personas"
 * @figma node-id=37-35380
 */
export function Personas({
  name,
  role,
  avatarVariant = "avatar-circle-initial",
  initials,
  src,
  alt,
  showNameAndRole = true,
  showRole = true,
  avatarClassName,
  className,
  ...props
}: PersonasProps) {
  return (
    <div
      {...props}
      data-figma-file-key={personasFigmaBinding.fileKey}
      data-figma-name={personasFigmaBinding.name}
      data-figma-node-id={personasFigmaBinding.nodeId}
      className={cn(
        "flex min-w-0 items-center gap-[var(--spacing-m)]",
        className,
      )}
    >
      <Avatar
        variant={avatarVariant}
        initials={initials}
        src={src}
        alt={alt}
        className={cn("size-8", avatarClassName)}
      />
      {showNameAndRole ? (
        <div className="flex min-w-0 flex-col justify-center gap-[var(--spacing-xs)]">
          <p className="truncate font-sans text-[14px] font-medium leading-[14px] tracking-[-0.42px] text-foreground">
            {name}
          </p>
          {showRole && role ? (
            <p className="truncate font-sans text-[12px] font-normal leading-[12px] tracking-[-0.36px] text-foreground-subtle">
              {role}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
