// SPDX-License-Identifier: BUSL-1.1
"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Avatar, TabLanguageSelector } from "@openshapeforge/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/overlay/popover";

type ShellLang = "en" | "nl";

type UserProfileMenuProps = {
  name: string;
  role?: string;
  activeLang: ShellLang;
};

const LANGUAGE_OPTIONS = [
  { value: "nl", label: "NL", fullName: "Nederlands" },
  { value: "en", label: "EN", fullName: "English" },
] as const;

function userInitials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function buildRedirectTarget(pathname: string, searchParams: URLSearchParams): string {
  const query = searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function UserProfileMenu({ name, role, activeLang }: UserProfileMenuProps) {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();

  const switchLanguage = React.useCallback(
    (nextLang: ShellLang) => {
      const redirectTo = buildRedirectTarget(pathname, searchParams);
      window.location.assign(
        `/api/shell/preferences?lang=${nextLang}&redirectTo=${encodeURIComponent(redirectTo)}`,
      );
    },
    [pathname, searchParams],
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Profielmenu openen"
          title="Profiel"
          className="flex size-8 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar variant="avatar-circle-initial" initials={userInitials(name)} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="w-64 p-3" aria-label="Profiel">
        <div className="space-y-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{name}</p>
            {role ? (
              <p className="truncate text-xs text-muted-foreground">{role}</p>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <span className="text-sm text-muted-foreground">Taal</span>
            <TabLanguageSelector<ShellLang>
              options={LANGUAGE_OPTIONS}
              value={activeLang}
              onChange={switchLanguage}
              ariaLabel="Interface taal"
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
