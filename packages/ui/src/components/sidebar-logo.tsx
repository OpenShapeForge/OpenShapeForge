// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { HTMLAttributes } from "react";
import { PanelLeftClose } from "lucide-react";

import { cn } from "../lib/cn";

export type LogoState = "logo-expanded" | "logo-collapsed" | "logo-hover";
export type SidebarLogoState = LogoState;

export interface LogoProps extends HTMLAttributes<HTMLDivElement> {
  /** Figma `state` axis. */
  state?: LogoState;
}

export type SidebarLogoProps = LogoProps;

function SidebarLogoMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn("text-[var(--color-foreground)]", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8.20519 15.7213C8.20519 16.3069 8.26161 16.883 8.37443 17.4497C8.48726 17.9975 8.67529 18.4981 8.93854 18.9515C9.2206 19.3859 9.58727 19.7354 10.0386 19.9998C10.4899 20.2643 11.054 20.3965 11.7309 20.3965C12.4078 20.3965 12.9719 20.2643 13.4232 19.9998C13.8933 19.7354 14.26 19.3859 14.5233 18.9515C14.8053 18.4981 15.0028 17.9975 15.1156 17.4497C15.2284 16.883 15.2848 16.3069 15.2848 15.7213C15.2848 15.1357 15.2284 14.5596 15.1156 13.9929C15.0028 13.4262 14.8053 12.9256 14.5233 12.4911C14.26 12.0567 13.8933 11.7072 13.4232 11.4428C12.9719 11.1594 12.4078 11.0177 11.7309 11.0177C11.054 11.0177 10.4899 11.1594 10.0386 11.4428C9.58727 11.7072 9.2206 12.0567 8.93854 12.4911C8.67529 12.9256 8.48726 13.4262 8.37443 13.9929C8.26161 14.5596 8.20519 15.1357 8.20519 15.7213ZM4.2 15.7213C4.2 14.5501 4.37863 13.4923 4.7359 12.5478C5.09317 11.5844 5.60088 10.7722 6.25901 10.111C6.91714 9.43099 7.7069 8.91152 8.62829 8.55261C9.54967 8.17481 10.5839 7.98592 11.7309 7.98592C12.8779 7.98592 13.9121 8.17481 14.8335 8.55261C15.7737 8.91152 16.5729 9.43099 17.231 10.111C17.8891 10.7722 18.3968 11.5844 18.7541 12.5478C19.1114 13.4923 19.29 14.5501 19.29 15.7213C19.29 16.8925 19.1114 17.9503 18.7541 18.8948C18.3968 19.8393 17.8891 20.6515 17.231 21.3316C16.5729 21.9927 15.7737 22.5027 14.8335 22.8616C13.9121 23.2206 12.8779 23.4 11.7309 23.4C10.5839 23.4 9.54967 23.2206 8.62829 22.8616C7.7069 22.5027 6.91714 21.9927 6.25901 21.3316C5.60088 20.6515 5.09317 19.8393 4.7359 18.8948C4.37863 17.9503 4.2 16.8925 4.2 15.7213Z"
        fill="currentColor"
      />
      <path d="M17.8968 0.600003V4.14184H5.26307V0.600001L17.8968 0.600003Z" fill="currentColor" />
    </svg>
  );
}

/**
 * Battery `logo` component used in the sidebar header.
 *
 * @figma component set — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-568
 * @figma state=logo-expanded — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-569
 * @figma state=logo-collapsed — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-572
 * @figma state=logo-hover — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-575
 */
export function Logo({ state = "logo-expanded", className, ...props }: LogoProps) {
  const isHover = state === "logo-hover";
  const isCollapsed = state === "logo-collapsed";

  return (
    <div
      data-slot="sidebar-logo"
      data-state={state}
      className={cn(
        "flex shrink-0 items-center justify-center",
        isHover && "size-6 rounded-[var(--radius-extrasmall)] bg-[var(--color-card)]",
        isCollapsed && "size-6",
        className,
      )}
      {...props}
    >
      {isHover ? (
        <PanelLeftClose className="size-5 text-[var(--color-foreground-muted)]" strokeWidth={1.5} aria-hidden="true" />
      ) : (
        <SidebarLogoMark className={cn(isCollapsed ? "size-[22px]" : "size-6")} />
      )}
    </div>
  );
}

export const SidebarLogo = Logo;
