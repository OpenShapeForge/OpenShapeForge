// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * The authenticated shell: the `@openshapeforge/ui` navigation rail, a header
 * identifying the operator, and a content well.
 *
 * REUSED, NOT COPIED. #290 asks for `@openshapeforge/ui` and
 * `@openshapeforge/auth` rather than duplicated components, and the reason
 * bites immediately: apps/web already has an `AppLayout`/`SidebarNav` stack,
 * but it is wired to compiler-generated nav manifests, a language context and a
 * tenant shell lookup — none of which exists here. Copying it would mean
 * forking a layout to delete the half that cannot work, then inheriting every
 * later fix to the original by hand. Consuming the shared primitives directly
 * costs one file and keeps both apps on the same components.
 *
 * A CLIENT component on purpose. `Sidebar` is a client component that takes an
 * icon COMPONENT (not a name) and an optional link implementation; handing it
 * those from a server component means pushing component references across the
 * RSC boundary. Being a client component here makes that a plain import.
 * `children` still arrives as a server-rendered slot, so pages under
 * `(console)/` stay server components and can keep doing server work.
 *
 * The nav is a static list, not a manifest, and an entry appears only once the
 * screen it points at exists — tenants with S5, sub-orgs with S6,
 * reconciliation with S7. A nav item linking to a route that does not resolve is
 * worse than a short nav: apps/web's sidebar already links `/tenants` and
 * `/tenant-settings`, neither of which exists there, and issue #286 opens by
 * calling exactly that out.
 *
 * Reconciliation is a TOP-LEVEL entry rather than a tab on a tenant, because the
 * question it answers is not per-tenant: one of its drift classes is "an
 * Organization no registry row claims", which belongs to no tenant at all and is
 * only visible from the realm side.
 *
 * `current` is derived from the pathname rather than passed in, because the
 * layout that renders this is a server component and would have to be handed a
 * pathname it does not have. `usePathname` needs a client component, which this
 * already is.
 */
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, LayoutDashboard, RefreshCcwDot } from "lucide-react";
import { Sidebar, Surface } from "@openshapeforge/ui";

interface ConsoleShellProps {
  operatorName?: string;
  operatorEmail?: string;
  children: ReactNode;
}

export function ConsoleShell({
  operatorName,
  operatorEmail,
  children,
}: ConsoleShellProps) {
  // `Sidebar` renders a logo button wired to `onToggle`. Left unwired it is a
  // control that visibly does nothing, so the state lives here. Local state,
  // not persisted: a remembered rail width is a preference worth storing once
  // there are preferences to store.
  const [expanded, setExpanded] = useState(true);
  const pathname = usePathname();
  // Prefix match, so `/tenants/acme` and `/tenants/new` keep the Tenants entry
  // lit. `/` needs an exact match or it would be current on every page.
  const onTenants = pathname === "/tenants" || pathname.startsWith("/tenants/");

  return (
    <div className="flex min-h-screen">
      {/*
        personAvatar / organizationAvatar / bottomAction are passed as null
        rather than left to their defaults ON PURPOSE: the component's defaults
        are Figma placeholders that load avatars from pravatar.cc and
        picsum.photos. A control plane that phones out to two third-party image
        hosts on every page render is not a default worth inheriting.
      */}
      <Sidebar
        state={expanded ? "expanded" : "collapsed"}
        onToggle={() => setExpanded((value) => !value)}
        aria-label="Control plane navigation"
        linkComponent={Link}
        bottomAction={null}
        personAvatar={null}
        organizationAvatar={null}
        groups={[
          {
            id: "control-plane",
            label: "Control plane",
            items: [
              {
                id: "overview",
                label: "Overview",
                icon: LayoutDashboard,
                href: "/",
                current: pathname === "/",
              },
              {
                id: "tenants",
                label: "Tenants",
                icon: Building2,
                href: "/tenants",
                current: onTenants,
              },
              {
                id: "reconciliation",
                label: "Reconciliation",
                icon: RefreshCcwDot,
                href: "/reconciliation",
                current: pathname === "/reconciliation",
              },
            ],
          },
        ]}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] px-6 py-4"
          style={{ backgroundColor: "var(--color-card)" }}
        >
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.24em] text-[var(--color-foreground-muted)]">
              OpenShapeForge
            </p>
            <h1 className="text-lg font-semibold tracking-tight">Control plane</h1>
          </div>
          <div className="text-right text-sm" data-testid="operator-identity">
            <p className="font-medium">{operatorName ?? "Operator"}</p>
            {operatorEmail ? (
              <p className="text-[var(--color-foreground-muted)]">{operatorEmail}</p>
            ) : null}
          </div>
        </header>

        <main className="min-w-0 flex-1 p-6">
          <Surface variant="card" className="p-6">
            {children}
          </Surface>
        </main>
      </div>
    </div>
  );
}
