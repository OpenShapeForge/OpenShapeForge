#!/usr/bin/env bun
/**
 * Regenerates THIRD-PARTY-NOTICES.md from the installed dependency tree.
 *
 *   bun run notices
 *
 * Walks bun's isolated store (node_modules/.bun/<key>/node_modules/<pkg>) for
 * every third-party package, reads its declared license + bundled license
 * text, and writes an aggregated, deduplicated notices file. Run after
 * changing dependencies.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const storeRoot = join(repoRoot, "node_modules/.bun");

type Pkg = {
  name: string;
  version: string;
  license: string;
  homepage: string;
  author: string;
  licenseText: string | null;
  depth: number;
};

function normalizeLicense(pkg: Record<string, any>): string {
  let lic: unknown = pkg.license;
  if (lic && typeof lic === "object" && !Array.isArray(lic)) lic = (lic as any).type;
  if (Array.isArray(lic)) {
    lic = lic.map((x) => (x && typeof x === "object" ? x.type : x)).join(" OR ");
  }
  if (!lic && Array.isArray(pkg.licenses)) {
    lic = pkg.licenses.map((x: any) => (x && typeof x === "object" ? x.type : x)).join(" OR ");
  }
  return (lic as string) || "SEE-REPOSITORY";
}

function findLicenseText(dir: string): string | null {
  for (const name of [
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "license",
    "LICENCE",
    "LICENSE-MIT",
    "COPYING",
  ]) {
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) return readFileSync(p, "utf8").trim();
    } catch {
      // not present
    }
  }
  return null;
}

/** Recursively collect package.json paths under a directory (bounded). */
function walkPackageJson(dir: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 6) return acc;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walkPackageJson(full, depth + 1, acc);
    } else if (entry === "package.json") {
      acc.push(full);
    }
  }
  return acc;
}

const byKey = new Map<string, Pkg>();
// Nested test/benchmark fixtures reuse generic names; skip them.
const FIXTURE_NAMES = new Set(["benchmarks", "transport"]);

for (const keyDir of readdirSync(storeRoot)) {
  const base = join(storeRoot, keyDir, "node_modules");
  for (const pjPath of walkPackageJson(base)) {
    let pkg: Record<string, any>;
    try {
      pkg = JSON.parse(readFileSync(pjPath, "utf8"));
    } catch {
      continue;
    }
    const { name, version } = pkg;
    if (!name || !version || String(name).startsWith("@openshapeforge/")) continue;
    if (FIXTURE_NAMES.has(name)) continue;
    const key = `${name}@${version}`;
    const depth = (pjPath.match(/node_modules/g) ?? []).length;
    const existing = byKey.get(key);
    if (existing && existing.depth <= depth) continue;
    const repo = pkg.repository;
    byKey.set(key, {
      name,
      version,
      license: normalizeLicense(pkg),
      homepage:
        pkg.homepage ||
        (repo && typeof repo === "object" ? repo.url : typeof repo === "string" ? repo : "") ||
        "",
      author:
        (pkg.author && typeof pkg.author === "object" ? pkg.author.name : pkg.author) || "",
      licenseText: findLicenseText(pjPath.slice(0, -"package.json".length)),
      depth,
    });
  }
}

const pkgs = [...byKey.values()].sort((a, b) =>
  `${a.name}`.toLowerCase().localeCompare(`${b.name}`.toLowerCase()),
);

const byLicense = new Map<string, number>();
for (const p of pkgs) byLicense.set(p.license, (byLicense.get(p.license) ?? 0) + 1);

const lines: string[] = [];
lines.push("# Third-Party Notices\n");
lines.push(
  "OpenShapeForge is distributed under the Business Source License 1.1 " +
    "(see [LICENSE](LICENSE)). It depends on the third-party open-source packages " +
    "listed below, each under its own license. This file satisfies the attribution " +
    "requirements of those licenses.\n",
);
lines.push(
  "These packages are **not** relicensed under OpenShapeForge's license — each remains " +
    "under the terms stated here. Their permissive licenses permit inclusion in a project " +
    "distributed under any license, including a source-available one.\n",
);
lines.push(`Regenerate with \`bun run notices\`. ${pkgs.length} packages.\n`);
lines.push("## License summary\n");
lines.push("| License | Packages |");
lines.push("| --- | --- |");
for (const [lic, n] of [...byLicense].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  lines.push(`| ${lic} | ${n} |`);
}
lines.push("\n## Packages\n");
for (const p of pkgs) {
  lines.push(`### ${p.name}@${p.version}`);
  lines.push(`- License: **${p.license}**${p.homepage ? ` — ${p.homepage}` : ""}`);
  if (p.author) lines.push(`- Author: ${p.author}`);
  lines.push("");
}

lines.push("---\n");
lines.push("## Full license texts\n");
const textToOwners = new Map<string, string[]>();
for (const p of pkgs) {
  if (!p.licenseText) continue;
  const owners = textToOwners.get(p.licenseText) ?? [];
  owners.push(`${p.name}@${p.version}`);
  textToOwners.set(p.licenseText, owners);
}
for (const [text, owners] of textToOwners) {
  lines.push(`<details><summary>${owners.join(", ")}</summary>\n`);
  lines.push("```");
  lines.push(text);
  lines.push("```");
  lines.push("</details>\n");
}

const content = lines.join("\n") + "\n";
const outPath = join(repoRoot, "THIRD-PARTY-NOTICES.md");

if (process.argv.includes("--check")) {
  // Gate mode: fail if the committed notices are stale (dependencies changed
  // without regenerating). Does not write.
  let existing = "";
  try {
    existing = readFileSync(outPath, "utf8");
  } catch {
    // missing file → treated as drift below
  }
  if (existing !== content) {
    console.error(
      "THIRD-PARTY-NOTICES.md is out of date with the installed dependencies.\n" +
        "Run `bun run notices` and commit the result.",
    );
    process.exit(1);
  }
  console.log(`THIRD-PARTY-NOTICES.md is up to date (${pkgs.length} packages).`);
} else {
  await Bun.write(outPath, content);
  console.log(
    `THIRD-PARTY-NOTICES.md: ${pkgs.length} packages, ${textToOwners.size} distinct license texts`,
  );
}
