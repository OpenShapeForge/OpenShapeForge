// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";

export type EntityAccessDeniedViewProps = {
  lang: string;
  /**
   * Optional friendly entity label to mention in the denial copy
   * (e.g. "panden" / "buildings"). When omitted, generic copy is used.
   */
  entityLabel?: string;
  /**
   * Optional secondary action (e.g. a back link). Rendered below the copy.
   */
  action?: ReactNode;
};

/**
 * Server-rendered access-denied view for compiler-generated entity surfaces.
 * Triggered when the GraphQL layer reports FORBIDDEN for the current persona.
 *
 * The `data-testid="entity-access-denied"` hook is what the access-control
 * UI E2E asserts on, so do not rename it without updating the test.
 */
export function EntityAccessDeniedView({
  lang,
  entityLabel,
  action,
}: EntityAccessDeniedViewProps) {
  const heading = lang === "nl" ? "Geen toegang" : "Access denied";
  const body =
    lang === "nl"
      ? entityLabel
        ? `Je account heeft geen toegang tot ${entityLabel}.`
        : "Je account heeft geen toegang tot dit onderdeel."
      : entityLabel
        ? `Your account does not have access to ${entityLabel}.`
        : "Your account does not have access to this section.";

  return (
    <section
      data-testid="entity-access-denied"
      data-lang={lang}
      className="flex flex-col items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-6 text-amber-900"
      role="alert"
      aria-live="polite"
    >
      <h2 className="text-lg font-semibold">{heading}</h2>
      <p className="text-sm">{body}</p>
      {action ? <div className="pt-2">{action}</div> : null}
    </section>
  );
}
