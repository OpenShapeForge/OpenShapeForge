// SPDX-License-Identifier: BUSL-1.1
import { Fragment, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { BodyHeaderBackButton } from "@/components/ui/layout/body-header-back-button";
import { cn } from "@/lib/utils";

type BreadcrumbLink = {
  label: string;
  href: string;
};

type BodyHeaderProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  className?: string;
  showBackButton?: boolean;
  backFallbackHref?: string;
  backLabel?: string;
  breadcrumbs?: BreadcrumbLink[];
};

export function BodyHeader({
  title,
  subtitle,
  className,
  showBackButton = true,
  backFallbackHref,
  backLabel,
  breadcrumbs,
}: BodyHeaderProps) {
  const hasBreadcrumbs = breadcrumbs && breadcrumbs.length > 0;
  return (
    <header className={cn("space-y-1.5", className)}>
      {hasBreadcrumbs ? (
        <nav className="flex flex-wrap items-center gap-x-0.5 gap-y-0.5 text-sm text-muted-foreground">
          {breadcrumbs.map((crumb, i) => (
            <Fragment key={crumb.href}>
              {i > 0 && <ChevronRight className="size-3.5 shrink-0" />}
              <Link
                href={crumb.href}
                className="max-w-[24ch] truncate hover:text-foreground"
              >
                {crumb.label}
              </Link>
            </Fragment>
          ))}
        </nav>
      ) : null}
      <div className="flex items-start gap-2">
        {!hasBreadcrumbs && showBackButton ? (
          <BodyHeaderBackButton
            fallbackHref={backFallbackHref}
            label={backLabel}
          />
        ) : null}
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      {subtitle ? (
        <p className="text-muted-foreground text-sm">{subtitle}</p>
      ) : null}
    </header>
  );
}
