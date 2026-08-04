// SPDX-License-Identifier: BUSL-1.1
/**
 * A tenant's lifecycle state, rendered the same way everywhere it appears.
 *
 * A plain server component rather than `@openshapeforge/ui`'s `Tag` or `Chip`:
 * both are neutral by design (one background, one foreground) and the whole
 * point here is that `suspended` must not look like `active` at a glance. The
 * colours come from the same `--color-*` tokens the ui package uses, so this is
 * consuming the design system rather than working around it.
 *
 * An unknown status renders as itself, muted. The `status` column is `text`
 * with no database constraint — deliberately, so adding a lifecycle state is a
 * TENANTSTATUS catalog edit rather than a migration — so a value this build has
 * not heard of is a state the operator still needs to SEE, not a reason to
 * render nothing or to guess.
 */

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  active: {
    label: "Active",
    className:
      "border-[var(--color-brand-aquamarine-60)] bg-[var(--color-brand-aquamarine-20)] text-[var(--color-foreground)]",
  },
  inactive: {
    label: "Inactive",
    className:
      "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground-muted)]",
  },
  suspended: {
    label: "Suspended",
    className:
      "border-[var(--color-functional-orange-60)] bg-[var(--color-functional-orange-10)] text-[var(--color-foreground)]",
  },
};

export function TenantStatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? {
    label: status,
    className:
      "border-[var(--color-border-subtle)] bg-[var(--color-background)] text-[var(--color-foreground-muted)]",
  };

  return (
    <span
      data-testid="tenant-status"
      data-status={status}
      className={`inline-flex items-center rounded-[var(--radius-extrasmall)] border px-2 py-0.5 text-[12px] font-medium leading-[16px] ${style.className}`}
    >
      {style.label}
    </span>
  );
}
