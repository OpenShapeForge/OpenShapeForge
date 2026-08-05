// SPDX-License-Identifier: BUSL-1.1
/**
 * Settings → API keys.
 *
 * The first page in a settings route group; the generated entity pages own
 * `(generated)` and the workflow editor owns `(plugins)`, and neither is a
 * sensible home for tenant administration.
 *
 * Data is loaded here rather than in the client component so the first paint
 * is real content, and so a caller without the management role gets the
 * explanatory empty state instead of a flash of controls followed by an error.
 */
import { listApiKeys, listGrantableRoles } from "@/actions/api-keys";
import { ApiKeyManager } from "@/features/api-keys/api-key-manager";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "API keys",
};

export default async function ApiKeysPage() {
  // A caller without Platform.ApiKeys.Manage gets FORBIDDEN from both fields.
  // That is the honest signal, and it is the API's decision rather than a role
  // check duplicated here — a second copy would be one more place to drift.
  let keys: Awaited<ReturnType<typeof listApiKeys>> = [];
  let roles: string[] = [];
  let canManage = true;
  let loadError: string | undefined;

  try {
    [keys, roles] = await Promise.all([listApiKeys(), listGrantableRoles()]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not authorized|forbidden/i.test(message)) {
      canManage = false;
    } else {
      loadError = message;
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">API keys</h1>
        <p className="text-sm text-muted-foreground">
          Give an external party programmatic access to your data — over
          GraphQL, REST or MCP — with the same roles that govern your own users.
          A key can never do more than the person who created it.
        </p>
      </header>

      <ApiKeyManager
        initialKeys={keys}
        grantableRoles={roles}
        canManage={canManage}
        loadError={loadError}
      />
    </main>
  );
}
