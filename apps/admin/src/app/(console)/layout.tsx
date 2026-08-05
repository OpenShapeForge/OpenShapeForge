// SPDX-License-Identifier: BUSL-1.1
/**
 * The gated half of the app.
 *
 * `(console)` is a ROUTE GROUP: the parentheses keep it out of the URL, so this
 * layout wraps `/` and every future control-plane route without adding a path
 * segment — while `/login` and `/not-authorized`, which sit outside the group,
 * stay reachable to a visitor with no operator session.
 *
 * That is the whole reason the gate lives here rather than in the root layout:
 * a root-layout gate would have to special-case its own login page, and a gate
 * with an exception list is a gate someone will eventually forget to update.
 * Here, "inside the group" IS the rule. S5 and S6 add their routes under
 * `(console)/` and inherit the gate by construction — nothing to remember.
 *
 * apps/web takes the equivalent approach per generated entity route rather than
 * per group, because its routes are compiler output and each one carries its
 * own authored authorization. This app has one rule for everything.
 *
 * There is no Next middleware doing this instead, deliberately: the session
 * lives in Redis behind ioredis, which does not run on the edge runtime, so a
 * middleware gate would either have to duplicate the session store or resolve
 * nothing. apps/web ships no middleware for the same reason.
 */
import type { ReactNode } from "react";
import { requireOperatorSession } from "@/lib/server/route-authz";
import { ConsoleShell } from "@/components/console-shell";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await requireOperatorSession("/");

  return (
    <ConsoleShell
      operatorName={
        session.user?.name ?? session.user?.preferredUsername ?? session.sub
      }
      operatorEmail={session.user?.email ?? undefined}
    >
      {children}
    </ConsoleShell>
  );
}
