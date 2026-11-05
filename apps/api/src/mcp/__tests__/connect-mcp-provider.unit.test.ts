// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
test("MCP provider connection honors canonical authorization", async () => {
  const fixture = fileURLToPath(new URL("./connect-mcp-provider.case.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "test", fixture], { stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, output: `${output}\n${errors}` }).toMatchObject({ code: 0 });
});
