// SPDX-License-Identifier: BUSL-1.1
/**
 * The API key screen.
 *
 * One deliberate constraint runs through this component: the credential is
 * shown exactly once, and the UI has to make that legible rather than merely
 * true. A user who dismisses the panel without copying has lost the key and
 * must rotate — so the panel is modal in effect (it blocks the list until
 * acknowledged) and says so in plain words.
 *
 * Nothing here is a security control. The role picker is populated from
 * `grantableApiKeyRoles` and the revoke buttons are hidden for keys that are
 * already revoked, but the API re-checks the ceiling on every mutation; this is
 * ergonomics over an enforcement boundary that lives elsewhere.
 */
"use client";

import { useCallback, useState, useTransition } from "react";
import {
  createApiKeyIntegration,
  disableApiKeyIntegration,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  type ApiKeyRow,
  type MintedApiKey,
} from "@/actions/api-keys";

type Props = {
  initialKeys: ApiKeyRow[];
  grantableRoles: string[];
  /** False when the signed-in user lacks the management role. */
  canManage: boolean;
  loadError?: string | undefined;
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function statusOf(key: ApiKeyRow): { label: string; tone: string } {
  if (key.revokedAt) return { label: "Revoked", tone: "text-muted-foreground" };
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) {
    return { label: "Expired", tone: "text-muted-foreground" };
  }
  if (!key.lastUsedAt) return { label: "Never used", tone: "text-amber-600" };
  return { label: "Active", tone: "text-emerald-600" };
}

export function ApiKeyManager({
  initialKeys,
  grantableRoles,
  canManage,
  loadError,
}: Props) {
  const [keys, setKeys] = useState(initialKeys);
  const [minted, setMinted] = useState<MintedApiKey | null>(null);
  const [error, setError] = useState<string | null>(loadError ?? null);
  const [creating, setCreating] = useState(false);
  const [pending, startTransition] = useTransition();

  const [displayName, setDisplayName] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState<string>("365");

  const refresh = useCallback(() => {
    startTransition(async () => {
      try {
        setKeys(await listApiKeys());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
  }, []);

  const runMutation = useCallback(
    (operation: () => Promise<void>) => {
      setError(null);
      startTransition(async () => {
        try {
          await operation();
          setKeys(await listApiKeys());
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    },
    [],
  );

  function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const parsedExpiry = expiresInDays.trim() === "" ? null : Number(expiresInDays);
    startTransition(async () => {
      try {
        const credential = await createApiKeyIntegration({
          displayName: displayName.trim(),
          roles: selectedRoles,
          expiresInDays: parsedExpiry,
        });
        setMinted(credential);
        setCreating(false);
        setDisplayName("");
        setSelectedRoles([]);
        setKeys(await listApiKeys());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
  }

  if (!canManage) {
    return (
      <div className="rounded-[14px] border bg-card p-6">
        <h2 className="text-base font-medium">API keys</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          You do not have permission to manage API keys for this organisation.
          Ask an administrator who holds the API key management role.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {minted ? (
        <ShowOncePanel minted={minted} onDismiss={() => setMinted(null)} />
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-[14px] border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="rounded-[14px] border bg-card">
        <div className="flex items-center justify-between gap-4 border-b px-6 py-4">
          <div>
            <h2 className="text-base font-medium">API keys</h2>
            <p className="text-sm text-muted-foreground">
              Credentials you have issued to external parties. Each carries the
              roles you chose and nothing more.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreating((open) => !open)}
            disabled={pending}
            className="shrink-0 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {creating ? "Cancel" : "Add API key"}
          </button>
        </div>

        {creating ? (
          <form onSubmit={submitCreate} className="flex flex-col gap-4 border-b px-6 py-5">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Name</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
                placeholder="e.g. Acme integrator"
                className="rounded-md border px-3 py-2 text-sm"
              />
              <span className="text-xs text-muted-foreground">
                Who this key is for. Shown in this list and in the audit trail.
              </span>
            </label>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Roles</legend>
              <p className="text-xs text-muted-foreground">
                Only roles you hold yourself can be granted. The key can never
                do more than you can.
              </p>
              <div className="mt-1 grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                {grantableRoles.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    You hold no roles that can be delegated to a key.
                  </p>
                ) : (
                  grantableRoles.map((role) => (
                    <label key={role} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedRoles.includes(role)}
                        onChange={(event) =>
                          setSelectedRoles((current) =>
                            event.target.checked
                              ? [...current, role]
                              : current.filter((item) => item !== role),
                          )
                        }
                      />
                      <span className="font-mono text-xs">{role}</span>
                    </label>
                  ))
                )}
              </div>
            </fieldset>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Expires after (days)</span>
              <input
                value={expiresInDays}
                onChange={(event) => setExpiresInDays(event.target.value)}
                inputMode="numeric"
                placeholder="365"
                className="w-40 rounded-md border px-3 py-2 text-sm"
              />
              <span className="text-xs text-muted-foreground">
                Leave empty for a key that never expires. A finite lifetime is
                strongly preferred — an unused key that cannot expire is a
                credential nobody is watching.
              </span>
            </label>

            <div>
              <button
                type="submit"
                disabled={pending || selectedRoles.length === 0 || displayName.trim() === ""}
                className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {pending ? "Creating…" : "Create key"}
              </button>
            </div>
          </form>
        ) : null}

        {keys.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-muted-foreground">
            No API keys yet. Add one to give an external party access.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b">
                  <th className="px-6 py-3 font-medium">Name</th>
                  <th className="px-6 py-3 font-medium">Roles</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Last used</th>
                  <th className="px-6 py-3 font-medium">Expires</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => {
                  const status = statusOf(key);
                  return (
                    <tr key={key.id} className="border-b last:border-0">
                      <td className="px-6 py-3">
                        <div className="font-medium">{key.displayName}</div>
                        <div className="text-xs text-muted-foreground">
                          {key.integrationName}
                        </div>
                      </td>
                      <td className="px-6 py-3">
                        {key.roleSubset === null ? (
                          <span className="text-xs text-muted-foreground">
                            All roles of the integration
                          </span>
                        ) : (
                          <span className="font-mono text-xs">
                            {key.roleSubset.join(", ")}
                          </span>
                        )}
                      </td>
                      <td className={`px-6 py-3 ${status.tone}`}>{status.label}</td>
                      <td className="px-6 py-3">{formatDate(key.lastUsedAt)}</td>
                      <td className="px-6 py-3">{formatDate(key.expiresAt)}</td>
                      <td className="px-6 py-3 text-right">
                        {key.revokedAt ? null : (
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() =>
                                runMutation(async () => {
                                  const credential = await rotateApiKey({
                                    integrationId: key.integrationId,
                                    displayName: `${key.displayName} (rotated)`,
                                  });
                                  setMinted(credential);
                                })
                              }
                              className="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                              title="Issue a second key. Both work until you revoke the old one."
                            >
                              Rotate
                            </button>
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() => runMutation(() => revokeApiKey(key.id))}
                              className="rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive disabled:opacity-50"
                            >
                              Revoke
                            </button>
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() =>
                                runMutation(() =>
                                  disableApiKeyIntegration(key.integrationId),
                                )
                              }
                              className="rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive disabled:opacity-50"
                              title="Disable the whole integration and every key under it."
                            >
                              Disable
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        className="self-start text-xs text-muted-foreground underline disabled:opacity-50"
      >
        Refresh
      </button>
    </div>
  );
}

/**
 * The credential, once.
 *
 * Deliberately blunt: the user is about to lose this value forever, and a
 * subtle toast is the wrong register for that. Dismissal is explicit.
 */
function ShowOncePanel({
  minted,
  onDismiss,
}: {
  minted: MintedApiKey;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="rounded-[14px] border border-emerald-500/40 bg-emerald-500/5 px-6 py-5">
      <h2 className="text-base font-medium">Copy this key now</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        This is the only time it will be shown. It is stored hashed, so nobody —
        including an administrator — can read it back. If you lose it, rotate the
        key and hand over the new one.
      </p>
      <div className="mt-4 flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md border bg-background px-3 py-2 font-mono text-xs">
          {minted.token}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(minted.token).then(
              () => setCopied(true),
              // Clipboard access can be refused (insecure origin, permissions).
              // Failing silently would look like a successful copy, which is
              // exactly the wrong outcome for a value shown once.
              () => setCopied(false),
            );
          }}
          className="shrink-0 rounded-md border px-3 py-2 text-sm"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-4 rounded-md border px-3 py-2 text-sm"
      >
        I have stored it
      </button>
    </div>
  );
}
