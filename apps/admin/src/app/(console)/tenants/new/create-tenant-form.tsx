// SPDX-License-Identifier: BUSL-1.1
"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@openshapeforge/ui";
import { createTenantAction } from "../actions";
import { IDLE_TENANT_FORM_STATE, type TenantFormState } from "../form-state";

/**
 * Create a tenant: a display name and a slug.
 *
 * ── The slug is explained, not just validated ───────────────────────────────
 *
 * It is the one field on this form that can never be changed afterwards. It
 * becomes the Keycloak Organization alias, the first segment of every
 * sub-organisation's `organizationPath`, and the URL key for every screen in
 * this app — so getting it wrong means creating a second tenant and abandoning
 * the first, not editing it. The form says that BEFORE the operator types,
 * rather than discovering it later on a disabled input.
 *
 * ── Validation lives on the server ──────────────────────────────────────────
 *
 * The `pattern` attribute here is a courtesy that saves a round trip; it is not
 * the rule. The rule is `assertSlug` in the control API, which is where a
 * malformed slug is actually refused (400 CONTROL_INVALID_INPUT), and this form
 * shows that refusal on the field rather than as a generic banner. Duplicating
 * the full rule in the browser would create a second definition of it, which is
 * how the two drift.
 */

function SubmitButton() {
  // useFormStatus reads the enclosing form's pending state, which is why this
  // is a child component rather than a `disabled={pending}` in the parent.
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="M" disabled={pending}>
      {pending ? "Creating…" : "Create tenant"}
    </Button>
  );
}

const inputClassName =
  "w-full rounded-[var(--radius-small)] border border-[var(--color-input-border)] bg-[var(--color-input)] px-3 py-2 font-sans text-[13px] text-[var(--color-foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-indigo-60)]";

export function CreateTenantForm() {
  const [state, formAction] = useActionState<TenantFormState, FormData>(
    createTenantAction,
    IDLE_TENANT_FORM_STATE,
  );

  const fieldError = (field: "slug" | "name") =>
    state.status === "error" && state.field === field ? state.message : undefined;
  // A refusal that names no field — an unreachable API, an unconfigured control
  // plane, a conflict — belongs above the form, not under an input.
  const formError =
    state.status === "error" && !state.field ? state : undefined;

  return (
    <form action={formAction} className="max-w-xl space-y-5" data-testid="create-tenant-form">
      {formError ? (
        <div
          role="alert"
          data-testid="create-tenant-error"
          data-code={formError.code}
          className="space-y-1 rounded-[var(--radius-medium)] border border-[var(--color-functional-red-40)] bg-[var(--color-functional-red-5)] p-3"
        >
          <p className="text-sm">{formError.message}</p>
          <p className="font-mono text-[12px] text-[var(--color-foreground-muted)]">
            {formError.code}
          </p>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="tenant-name" className="block text-sm font-medium">
          Name
        </label>
        <input
          id="tenant-name"
          name="name"
          required
          maxLength={200}
          defaultValue={state.values?.name ?? ""}
          autoComplete="off"
          className={inputClassName}
          aria-describedby="tenant-name-help"
          {...(fieldError("name") ? { "aria-invalid": true } : {})}
        />
        <p id="tenant-name-help" className="text-[12px] text-[var(--color-foreground-muted)]">
          The human-readable name. Editable later, and never used as an identifier —
          Keycloak gets identifiers derived from the slug instead, because organization
          names must be unique per realm and two tenants may legitimately share a label.
        </p>
        {fieldError("name") ? (
          <p className="text-[12px] text-[var(--color-functional-red-100)]" data-testid="name-error">
            {fieldError("name")}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="tenant-slug" className="block text-sm font-medium">
          Slug <span className="text-[var(--color-foreground-muted)]">(permanent)</span>
        </label>
        <input
          id="tenant-slug"
          name="slug"
          required
          minLength={2}
          maxLength={63}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          placeholder="acme-holding"
          defaultValue={state.values?.slug ?? ""}
          autoComplete="off"
          spellCheck={false}
          className={`${inputClassName} font-mono`}
          aria-describedby="tenant-slug-help"
          {...(fieldError("slug") ? { "aria-invalid": true } : {})}
        />
        <p id="tenant-slug-help" className="text-[12px] text-[var(--color-foreground-muted)]">
          Lowercase letters and digits in single-hyphen groups. <strong>Cannot be changed
          after creation</strong>: it is the Keycloak Organization alias, the path segment
          every sub-organisation inherits, and this console&rsquo;s URL key.
        </p>
        {fieldError("slug") ? (
          <p className="text-[12px] text-[var(--color-functional-red-100)]" data-testid="slug-error">
            {fieldError("slug")}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton />
        <Button asChild variant="outline" size="M">
          <Link href="/tenants">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
