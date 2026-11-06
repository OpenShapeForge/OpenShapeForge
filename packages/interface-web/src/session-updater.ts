// SPDX-License-Identifier: BUSL-1.1
/** Keep an admitted login mounted during renewal; fence stale success AND failure. */
export function createWebSessionUpdater<User, Session>(options: {
  sessionKey(user: User): string | null | undefined;
  resolve(user: User, scope: string): Promise<Session>;
  update(session: Session | undefined): void;
}) {
  let revision = 0;
  let closed = false;
  let current: { key: string; scope: string } | undefined;
  return {
    async set(user: User | undefined, scope = ""): Promise<void> {
      if (closed) return;
      const turn = ++revision;
      const key = user === undefined ? undefined : options.sessionKey(user)?.trim();
      if (!key || current?.key !== key || current.scope !== scope) {
        current = undefined;
        options.update(undefined);
      }
      if (user === undefined) return;
      try {
        const session = await options.resolve(user, scope);
        if (closed || turn !== revision) return;
        current = key ? { key, scope } : undefined;
        options.update(session);
      } catch (error) {
        // An older rejection must not sign out a newer admitted login.
        if (!closed && turn === revision) throw error;
      }
    },
    close() { closed = true; revision += 1; current = undefined; },
  };
}
