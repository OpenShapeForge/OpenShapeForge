// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("connect provider recovery uses isolated mocked dependencies", async () => {
  // Module mocks are process-global in Bun; isolate them from the API suite.
  const fixture = fileURLToPath(new URL("./connect-provider-recovery.case.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "test", fixture], { stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, output: `${output}\n${errors}` }).toMatchObject({ code: 0 });
});
