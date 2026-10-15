// SPDX-License-Identifier: BUSL-1.1
/** The OIDC client owns logout, token hints and callback-state validation. */
export type SessionRecoveryManager = {
  removeUser(): Promise<void>;
  signoutRedirect(args: { state: { kind: string; returnTo: string } }): Promise<void>;
  signoutRedirectCallback(url?: string): Promise<{ state?: unknown }>;
  signinRedirect(args: { prompt: string; state: { returnTo: string } }): Promise<void>;
};
type RecoveryStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const KEY = "osf.web-session-recovery.v1";
const KIND = "rejected-web-session";
function browser() {
  return (globalThis as unknown as { window: {
    sessionStorage: RecoveryStore; location: { href: string };
    history: { replaceState(data: unknown, title: string, path: string): void };
  } }).window;
}

function localPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\u0000-\u0020\u007f]/u.test(path)
    || new URL(path, "https://application.invalid").origin !== "https://application.invalid") {
    throw new Error("The login landing page must be a local application path.");
  }
  return path;
}

export function clearRejectedWebSessionRestart(store: RecoveryStore = browser().sessionStorage): void {
  store.removeItem(KEY);
}

/** Keep the saved ID token until the OIDC client has constructed native logout. */
export async function restartRejectedWebSession(
  manager: SessionRecoveryManager, returnTo: string, store: RecoveryStore = browser().sessionStorage,
): Promise<boolean> {
  localPath(returnTo);
  if (store.getItem(KEY)) {
    await manager.removeUser();
    return false; // Another rejected token needs attention, never a redirect loop.
  }
  store.setItem(KEY, JSON.stringify({ returnTo, phase: "logout" }));
  try {
    await manager.signoutRedirect({ state: { kind: KIND, returnTo } });
    return true;
  } catch (error) {
    await manager.removeUser();
    throw error; // Keep the guard: an unavailable logout must not restart itself.
  }
}

/** Resume only the server/client-validated logout callback belonging to this attempt. */
export async function completeRejectedWebSessionLogout(
  manager: SessionRecoveryManager,
  url: string = browser().location.href,
  store: RecoveryStore = browser().sessionStorage,
  replace: (path: string) => void = path => browser().history.replaceState(null, "", path),
): Promise<boolean> {
  const saved = store.getItem(KEY);
  if (!saved) return false;
  const pending = JSON.parse(saved) as { returnTo: string; phase: string };
  const query = new URL(url).searchParams;
  if (pending.phase !== "logout" || !query.has("state") || query.has("code")) return false;
  const result = await manager.signoutRedirectCallback(url);
  const state = result.state as { kind?: string; returnTo?: string } | undefined;
  if (state?.kind !== KIND || state.returnTo !== pending.returnTo) throw new Error("Unexpected logout recovery state.");
  const returnTo = localPath(pending.returnTo);
  store.setItem(KEY, JSON.stringify({ returnTo, phase: "login" }));
  replace(returnTo);
  await manager.signinRedirect({ prompt: "login", state: { returnTo } });
  return true;
}
