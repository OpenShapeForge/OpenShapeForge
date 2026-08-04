// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@openshapeforge/ui";
import type { Tenant } from "@/lib/clients/control-api";
import { renameTenantAction, setTenantStatusAction } from "../actions";
import { IDLE_TENANT_FORM_STATE, type TenantFormState } from "../form-state";

/**
 * The two things an existing tenant can be told to do, and the one it cannot.
 *
 * SUSPEND / REACTIVATE writes `platform.tenants.status` and mirrors it onto the
 * Keycloak Organization's `enabled` flag — the tenant's Organization is enabled
 * if and only if the tenant is `active`. The detail page above shows both sides
 * afterwards, read back from Keycloak rather than assumed, so a projection that
 * failed to apply is visible instead of merely reported.
 *
 * RENAME changes the display name and nothing else. It touches Keycloak not at
 * all: the Organization's alias and name are derived from the SLUG, never from
 * the human label.
 *
 * There is no third control. The slug has no form here because it has no
 * operation anywhere — the control API's update endpoint refuses a body that
 * carries one, and `updateTenant` in the client has no parameter for it. A
 * disabled input would suggest an affordance that is merely switched off; the
 * absence of one is the accurate statement.
 */

function ErrorNote({ state }: { state: TenantFormState }) {
  if (state.status !== "error") return null;
  return (
    <p
      role="alert"
      data-testid="tenant-action-error"
      data-code={state.code}
      className="text-[12px] text-[var(--color-functional-red-100)]"
    >
      {state.message} <span className="font-mono">({state.code})</span>
    </p>
  );
}

function PendingButton({
  children,
  pendingLabel,
  variant,
}: {
  children: string;
  pendingLabel: string;
  variant: "primary" | "destructive" | "outline";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="M" disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

const TRANSITIONS = [
  { status: "active", label: "Reactivate", pendingLabel: "Reactivating…", variant: "primary" },
  { status: "suspended", label: "Suspend", pendingLabel: "Suspending…", variant: "destructive" },
  { status: "inactive", label: "Mark inactive", pendingLabel: "Updating…", variant: "outline" },
] as const;

export function TenantLifecycleControls({ tenant }: { tenant: Tenant }) {
  const [state, formAction] = useActionState<TenantFormState, FormData>(
    setTenantStatusAction,
    IDLE_TENANT_FORM_STATE,
  );

  // Three states, two useful transitions from any of them. `inactive` is
  // offered alongside `suspended` because they are different facts — wound
  // down versus stopped — even though both disable the Organization.
  const transitions = TRANSITIONS.filter(
    (transition) => transition.status !== tenant.status,
  );

  return (
    <div className="space-y-2" data-testid="tenant-lifecycle">
      <div className="flex flex-wrap items-center gap-2">
        {transitions.map((transition) => (
          <form key={transition.status} action={formAction}>
            <input type="hidden" name="slug" value={tenant.slug} />
            <input type="hidden" name="status" value={transition.status} />
            <PendingButton pendingLabel={transition.pendingLabel} variant={transition.variant}>
              {transition.label}
            </PendingButton>
          </form>
        ))}
      </div>
      <ErrorNote state={state} />
    </div>
  );
}

export function TenantRenameForm({ tenant }: { tenant: Tenant }) {
  const [state, formAction] = useActionState<TenantFormState, FormData>(
    renameTenantAction,
    IDLE_TENANT_FORM_STATE,
  );

  return (
    <form action={formAction} className="space-y-2" data-testid="tenant-rename">
      <input type="hidden" name="slug" value={tenant.slug} />
      <label htmlFor="rename-name" className="block text-sm font-medium">
        Name
      </label>
      <div className="flex max-w-xl items-center gap-2">
        <input
          id="rename-name"
          name="name"
          required
          maxLength={200}
          defaultValue={state.values?.name ?? tenant.name}
          autoComplete="off"
          className="w-full rounded-[var(--radius-small)] border border-[var(--color-input-border)] bg-[var(--color-input)] px-3 py-2 font-sans text-[13px] text-[var(--color-foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-indigo-60)]"
        />
        <PendingButton pendingLabel="Saving…" variant="outline">
          Rename
        </PendingButton>
      </div>
      <ErrorNote state={state} />
    </form>
  );
}
