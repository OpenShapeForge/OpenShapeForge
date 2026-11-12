// SPDX-License-Identifier: BUSL-1.1
/** Generate credentials outside source and retained browser evidence. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a fresh private fixture directory.");
await mkdir(directory, { mode: 0o700 });
const values = Object.fromEntries([
  "AUTH_RECOVERY_CLIENT_SECRET", "AUTH_RECOVERY_PASSWORD", "AUTH_RECOVERY_AUTH_SECRET",
].map(name => [name, randomBytes(32).toString("hex")]));
const realm = await Bun.file(new URL("realm.json", import.meta.url)).json();
realm.clients[0].secret = values.AUTH_RECOVERY_CLIENT_SECRET;
realm.users[0].credentials = [{ type: "password", value: values.AUTH_RECOVERY_PASSWORD, temporary: false }];
// Keycloak's non-root container user reads this bind-mounted file; the parent is private.
await writeFile(resolve(directory, "session-recovery-test-realm.json"), JSON.stringify(realm), { mode: 0o644 });
await writeFile(resolve(directory, "fixture.env"), Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
