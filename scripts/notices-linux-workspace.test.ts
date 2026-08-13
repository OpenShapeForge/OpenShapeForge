// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Linux notices workspace isolation", () => {
  for (const scriptName of ["notices:linux", "check:notices:linux"] as const) {
    test(`${scriptName} uses a container-only install`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "osf-notices-script-"));
      temporaryDirectories.push(directory);
      const invocationLog = join(directory, "docker-arguments");
      const docker = join(directory, "docker");
      const bun = join(directory, "bun");

      await writeFile(
        docker,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >"${invocationLog}"
found_workspace_volume=false
found_node_modules_volume=false
while (($#)); do
  if [[ "$1" == "-v" && "\${2:-}" == */w ]]; then
    found_workspace_volume=true
  fi
  if [[ "$1" == "-v" && "\${2:-}" == "/w/node_modules" ]]; then
    found_node_modules_volume=true
  fi
  shift
done
[[ "$found_workspace_volume" == true && "$found_node_modules_volume" == true ]]
`,
      );
      await writeFile(
        bun,
        "#!/usr/bin/env bash\necho 'host bun invocation is forbidden' >&2\nexit 88\n",
      );
      await Promise.all([chmod(docker, 0o700), chmod(bun, 0o700)]);

      const packageJson = JSON.parse(
        await readFile(join(import.meta.dir, "../package.json"), "utf8"),
      ) as { scripts: Record<string, string> };
      const process = Bun.spawn(["/bin/bash", "-c", packageJson.scripts[scriptName]], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...Bun.env,
          PATH: `${directory}:/usr/bin:/bin:/usr/sbin:/sbin`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [exitCode, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(await readFile(invocationLog, "utf8")).toContain("/w/node_modules\n");
    });
  }
});
