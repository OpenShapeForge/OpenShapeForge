// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@openshapeforge/ui";
import type { OrgUnitNode, OrgUnitTree } from "@/lib/clients/control-api";
import {
  createOrgUnitAction,
  renameOrgUnitAction,
  reparentOrgUnitAction,
} from "./actions";
import { IDLE_ORG_UNIT_FORM_STATE, type OrgUnitFormState } from "./form-state";

/**
 * The sub-organisation tree, and the three things an operator can do to it.
 *
 * ── Why the tree arrives assembled ──────────────────────────────────────────
 *
 * The API returns nested nodes rather than a flat list with `parentId`s. The
 * ordering invariant that makes assembly correct — a child never precedes its
 * parent — is enforced by the query's `ORDER BY depth`, and re-deriving it here
 * would put one rule in two places. This component renders what it is given.
 *
 * ── Why the reparent options are computed per node ──────────────────────────
 *
 * A unit cannot be moved beneath itself or beneath one of its own descendants —
 * that would detach the subtree from the tree entirely. The API refuses it
 * (`CONTROL_ORG_UNIT_CYCLE`) and this list leaves it out, which is the
 * difference between an operator learning the rule from an error and never
 * being offered the mistake. The API check is the one that counts: a `<select>`
 * is a suggestion, and a server action's arguments are whatever the client
 * sent.
 *
 * ── Why a unit at the cap is not offered as a parent ────────────────────────
 *
 * `maxDepth` comes from the API rather than being hard-coded, so the cap has
 * exactly one definition. A unit already at the cap is left out of the create
 * form's parent list, because offering it and refusing the submission afterwards
 * teaches nothing. The move control still offers it — a MOVE onto it may be
 * legal or not depending on how deep the moved subtree is, and that arithmetic
 * belongs on the server where the subtree's real depth is known.
 *
 * ── The one control that does not exist ─────────────────────────────────────
 *
 * There is no slug field on any form here except the create form, and no action
 * that changes one. A sub-organisation's slug is its `organizationPath`
 * segment, so editing it would move this unit's path and every descendant's,
 * exactly as a reparent does — without being one. Rename changes the display
 * name; reparent changes the structure. A disabled input would suggest an
 * affordance that is merely switched off; its absence is the accurate
 * statement.
 */

const inputClassName =
  "w-full rounded-[var(--radius-small)] border border-[var(--color-input-border)] bg-[var(--color-input)] px-2.5 py-1.5 font-sans text-[13px] text-[var(--color-foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-indigo-60)]";

function PendingButton({
  children,
  pendingLabel,
  variant = "outline",
}: {
  children: string;
  pendingLabel: string;
  variant?: "primary" | "outline";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="sm" disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

/**
 * A refusal, shown only against the node it belongs to.
 *
 * Every node renders its forms against ONE action apiece, so the reducer state
 * is shared across rows; `orgUnitId` on the state is what keeps a refusal on
 * one row from appearing under all of them.
 */
function ErrorNote({ state, orgUnitId }: { state: OrgUnitFormState; orgUnitId?: string }) {
  if (state.status !== "error") return null;
  if (orgUnitId && state.orgUnitId && state.orgUnitId !== orgUnitId) return null;
  return (
    <p
      role="alert"
      data-testid="org-unit-error"
      data-code={state.code}
      data-org-unit-id={state.orgUnitId ?? ""}
      className="text-[12px] text-[var(--color-functional-red-100)]"
    >
      {state.message} <span className="font-mono">({state.code})</span>
    </p>
  );
}

function flatten(nodes: readonly OrgUnitNode[]): OrgUnitNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** Every unit that may legally become `node`'s parent: not itself, not a descendant. */
function reparentOptions(node: OrgUnitNode, all: readonly OrgUnitNode[]): OrgUnitNode[] {
  const forbidden = new Set(flatten([node]).map((descendant) => descendant.id));
  return all.filter((candidate) => !forbidden.has(candidate.id));
}

export function OrgUnitTreeView({ tree }: { tree: OrgUnitTree }) {
  const [createState, createAction] = useActionState<OrgUnitFormState, FormData>(
    createOrgUnitAction,
    IDLE_ORG_UNIT_FORM_STATE,
  );
  const [renameState, renameAction] = useActionState<OrgUnitFormState, FormData>(
    renameOrgUnitAction,
    IDLE_ORG_UNIT_FORM_STATE,
  );
  const [reparentState, reparentAction] = useActionState<OrgUnitFormState, FormData>(
    reparentOrgUnitAction,
    IDLE_ORG_UNIT_FORM_STATE,
  );

  const all = flatten(tree.roots);

  function renderNode(node: OrgUnitNode): React.ReactNode {
    const options = reparentOptions(node, all);

    return (
      <li key={node.id} data-testid="org-unit-node" data-org-unit-id={node.id} data-depth={node.depth}>
        <div className="space-y-2 rounded-[var(--radius-medium)] border border-[var(--color-border-subtle)] p-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-medium" data-testid="org-unit-name">
              {node.name}
            </span>
            <span
              className="font-mono text-[12px] text-[var(--color-foreground-muted)]"
              data-testid="org-unit-path"
            >
              {node.path ?? "no path — this unit or an ancestor has no slug"}
            </span>
            <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-foreground-muted)]">
              depth {node.depth}
            </span>
          </div>

          <p className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
            org unit {node.id} ·{" "}
            <span data-testid="org-unit-organization-id">
              {node.keycloakOrganizationId ?? (
                // Provisioning is DB-first, so this is a recoverable state
                // rather than a corruption — and a reparent will report it as
                // skipped rather than silently creating the Organization.
                <span className="text-[var(--color-functional-orange-100)]">
                  no Keycloak organization — replay its create
                </span>
              )}
            </span>
          </p>

          <div className="flex flex-wrap items-end gap-4">
            <form action={renameAction} className="flex items-end gap-2" data-testid="org-unit-rename">
              <input type="hidden" name="tenantSlug" value={tree.tenant.slug} />
              <input type="hidden" name="orgUnitId" value={node.id} />
              <label className="space-y-1">
                <span className="block text-[11px] text-[var(--color-foreground-muted)]">
                  Name
                </span>
                <input
                  name="name"
                  required
                  maxLength={200}
                  defaultValue={node.name}
                  autoComplete="off"
                  className={inputClassName}
                />
              </label>
              <PendingButton pendingLabel="Saving…">Rename</PendingButton>
            </form>

            <form
              action={reparentAction}
              className="flex items-end gap-2"
              data-testid="org-unit-reparent"
            >
              <input type="hidden" name="tenantSlug" value={tree.tenant.slug} />
              <input type="hidden" name="orgUnitId" value={node.id} />
              <label className="space-y-1">
                <span className="block text-[11px] text-[var(--color-foreground-muted)]">
                  Parent
                </span>
                <select
                  name="parentOrgUnitId"
                  defaultValue={node.parentId ?? ""}
                  className={inputClassName}
                >
                  <option value="">{tree.tenant.slug} (top level)</option>
                  {options.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.path ?? candidate.name}
                    </option>
                  ))}
                </select>
              </label>
              <PendingButton pendingLabel="Moving…">Move</PendingButton>
            </form>
          </div>

          <ErrorNote state={renameState} orgUnitId={node.id} />
          <ErrorNote state={reparentState} orgUnitId={node.id} />
        </div>

        {node.children.length > 0 ? (
          <ul className="ml-6 mt-2 space-y-2 border-l border-dashed border-[var(--color-border-subtle)] pl-4">
            {node.children.map(renderNode)}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <div className="space-y-6" data-testid="org-unit-tree">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Hierarchy</h3>
        {tree.roots.length === 0 ? (
          <p
            data-testid="org-units-empty"
            className="rounded-[var(--radius-medium)] border border-dashed border-[var(--color-border-subtle)] p-6 text-sm text-[var(--color-foreground-muted)]"
          >
            No sub-organisations yet. Creating one writes a{" "}
            <code className="font-mono">platform.org_unit</code> row and a child Keycloak
            Organization sharing this tenant&rsquo;s root.
          </p>
        ) : (
          <ul className="space-y-2">{tree.roots.map(renderNode)}</ul>
        )}
        {tree.truncated ? (
          <p className="text-sm text-[var(--color-functional-orange-100)]">
            Showing the shallowest part of the tree only — this tenant has more units than
            the list returns. The cut is by depth, so nothing shown is missing its parent.
          </p>
        ) : null}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Add a sub-organisation</h3>
        <form
          action={createAction}
          className="flex max-w-3xl flex-wrap items-end gap-3"
          data-testid="create-org-unit-form"
        >
          <input type="hidden" name="tenantSlug" value={tree.tenant.slug} />
          <label className="space-y-1">
            <span className="block text-[11px] text-[var(--color-foreground-muted)]">
              Name
            </span>
            <input
              name="name"
              required
              maxLength={200}
              defaultValue={createState.values?.name ?? ""}
              autoComplete="off"
              className={inputClassName}
            />
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] text-[var(--color-foreground-muted)]">
              Slug <span className="text-[var(--color-foreground-muted)]">(permanent)</span>
            </span>
            <input
              name="slug"
              required
              minLength={2}
              maxLength={63}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              placeholder="emea"
              defaultValue={createState.values?.slug ?? ""}
              autoComplete="off"
              spellCheck={false}
              className={`${inputClassName} font-mono`}
            />
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] text-[var(--color-foreground-muted)]">
              Parent
            </span>
            <select
              name="parentOrgUnitId"
              defaultValue={createState.values?.parentOrgUnitId ?? ""}
              className={inputClassName}
            >
              <option value="">{tree.tenant.slug} (top level)</option>
              {/* A unit already at the cap cannot take a child; the API would
                  refuse it, so it is not offered. */}
              {all
                .filter((candidate) => candidate.depth < tree.maxDepth)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.path ?? candidate.name}
                  </option>
                ))}
            </select>
          </label>
          <PendingButton pendingLabel="Creating…" variant="primary">
            Add
          </PendingButton>
        </form>
        <p className="max-w-3xl text-[12px] text-[var(--color-foreground-muted)]">
          The slug is this unit&rsquo;s segment of the{" "}
          <code className="font-mono">organizationPath</code> and cannot be changed
          afterwards — changing it would move this unit&rsquo;s path and every
          descendant&rsquo;s, which is what the <strong>Move</strong> control is for. The
          display name is free to change and never reaches Keycloak: the Organization&rsquo;s
          alias is bound to the unit&rsquo;s id, which is why a move can keep the same
          Organization at all.
        </p>
        <ErrorNote state={createState} />
      </section>
    </div>
  );
}
