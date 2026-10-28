// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { parse } from "yaml";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const workflow = parse(readFileSync(new URL("../../../../../.github/workflows/deploy.yml", import.meta.url), "utf8"));
test("deployment shell never interpolates dispatch values or derived outputs as code", () => {
  for (const job of Object.values(workflow.jobs) as any[]) for (const step of job.steps ?? []) {
    if (typeof step.run !== "string") continue;
    expect(step.run).not.toMatch(/\$\{\{[^}]*(?:inputs\.|steps\.(?:tag|issuer)\.outputs)/);
    const check = Bun.spawnSync(["bash", "-n"], {stdin:Buffer.from(step.run)});
    expect(check.exitCode).toBe(0);
  }
});
test("a shell command in an image tag remains inert environment data", () => {
  const dir = mkdtempSync(join(tmpdir(),"osf-shell-"));
  try {
    const marker = join(dir,"executed");
    const payload = `$(touch ${marker})`;
    const steps = Object.values(workflow.jobs).flatMap((job:any)=>job.steps ?? []);
    const script = (steps.find((s:any)=>s.id === "tag") as any).run;
    const result = Bun.spawnSync(["bash","-eu","-c",script],{env:{...process.env,DEPLOY_IMAGE_TAG:payload,GITHUB_OUTPUT:join(dir,"output"),GITHUB_SHA:"abcdef123"}});
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(dir,"output"),"utf8")).toContain(payload);
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
