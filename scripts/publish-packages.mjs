#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
/**
 * Publish every non-private workspace package to the GitHub Packages npm
 * registry, in dependency order, with workspace-internal specifiers rewritten
 * to the versions published in the same run.
 *
 *   bun scripts/publish-packages.mjs --channel main
 *   bun scripts/publish-packages.mjs --channel dev --sha <commit> [--dry-run]
 *
 * Channels:
 *   main  Publishes each package.json version under `latest`. A version that
 *         already exists with identical contents is a no-op; one that exists
 *         with different contents is a missing version bump and fails before
 *         anything is published. `workspace:*` becomes `^<version>`; declared
 *         ranges stay as they are.
 *   dev   Publishes `<version>-dev.<8-char sha>` under the `dev` dist-tag. A
 *         version that already exists is skipped (the sha names the content).
 *         Every internal dependency and peer dependency is pinned to the exact
 *         version published in this run, so a prerelease resolves its siblings
 *         to the same commit.
 *
 * The package.json files are rewritten in place for packing and restored
 * afterwards, so the working tree is left untouched. LICENSE (and the compiler's
 * README, which is docs/consuming.md) are staged into the package directories
 * for packing and removed again afterwards.
 *
 * Authentication comes from ~/.npmrc: `npm view` needs a read token on this
 * registry as much as `npm publish` needs a write token.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://npm.pkg.github.com";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { channel: null, sha: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--channel") options.channel = argv[++index];
    else if (argument === "--sha") options.sha = argv[++index];
    else if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.channel !== "main" && options.channel !== "dev") {
    throw new Error("--channel must be main or dev");
  }
  if (options.channel === "dev" && !/^[0-9a-f]{8,40}$/.test(options.sha ?? "")) {
    throw new Error("--channel dev needs --sha <commit sha>");
  }
  return options;
}

function loadPublishablePackages() {
  const packagesDir = path.join(repoRoot, "packages");
  const packages = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(packagesDir, entry.name, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (manifest.private === true) continue;
    packages.push({ dir: path.join(packagesDir, entry.name), manifestPath, manifest });
  }
  return packages;
}

const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/** Topological order over the publishable set; a cycle is a configuration error. */
function dependencyOrder(packages) {
  const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]));
  const ordered = [];
  const state = new Map();
  const visit = (entry, trail) => {
    const name = entry.manifest.name;
    if (state.get(name) === "done") return;
    if (state.get(name) === "active") {
      throw new Error(`Dependency cycle among publishable packages: ${[...trail, name].join(" -> ")}`);
    }
    state.set(name, "active");
    for (const field of DEPENDENCY_FIELDS) {
      for (const dependency of Object.keys(entry.manifest[field] ?? {})) {
        const target = byName.get(dependency);
        if (target) visit(target, [...trail, name]);
      }
    }
    state.set(name, "done");
    ordered.push(entry);
  };
  for (const entry of packages) visit(entry, []);
  return ordered;
}

function publishedVersionFor(manifest, options) {
  if (options.channel === "main") return manifest.version;
  return `${manifest.version}-dev.${options.sha.slice(0, 8)}`;
}

function rewriteManifest(manifest, versions, options) {
  const rewritten = structuredClone(manifest);
  rewritten.version = versions.get(manifest.name);
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dependency, specifier] of Object.entries(rewritten[field] ?? {})) {
      const published = versions.get(dependency);
      if (!published) continue;
      if (options.channel === "dev") rewritten[field][dependency] = published;
      else if (specifier === "workspace:*") rewritten[field][dependency] = `^${published}`;
    }
  }
  return rewritten;
}

function npm(args, { allowFailure = false } = {}) {
  try {
    return { ok: true, stdout: execFileSync("npm", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    if (!allowFailure) throw error;
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

/** The registry's integrity for name@version, null when that version is absent. */
function publishedIntegrity(name, version) {
  const result = npm(["view", `${name}@${version}`, "dist.integrity", "--json", `--registry=${REGISTRY}`], { allowFailure: true });
  if (result.ok) {
    const parsed = result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
    return parsed === null ? null : { integrity: parsed };
  }
  if (/E404/.test(result.stderr)) return null;
  throw new Error(`npm view ${name}@${version} failed:\n${result.stderr}`);
}

/** Copies LICENSE (and the compiler's README) into the package; returns the paths it created. */
function stageDistributionFiles(entry) {
  const copies = [[path.join(repoRoot, "LICENSE"), path.join(entry.dir, "LICENSE")]];
  if (entry.manifest.name === "@openshapeforge/compiler") {
    copies.push([path.join(repoRoot, "docs", "consuming.md"), path.join(entry.dir, "README.md")]);
  }
  const created = [];
  for (const [source, target] of copies) {
    if (existsSync(target)) continue;
    copyFileSync(source, target);
    created.push(target);
  }
  return created;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const ordered = dependencyOrder(loadPublishablePackages());
  const versions = new Map(ordered.map((entry) => [entry.manifest.name, publishedVersionFor(entry.manifest, options)]));
  const tag = options.channel === "main" ? "latest" : "dev";
  const packDestination = mkdtempSync(path.join(tmpdir(), "publish-packages-"));
  const originals = new Map(ordered.map((entry) => [entry.manifestPath, readFileSync(entry.manifestPath, "utf8")]));
  const staged = [];

  console.log(`Channel ${options.channel}, dist-tag ${tag}, ${ordered.length} packages in dependency order:`);
  for (const entry of ordered) console.log(`  ${entry.manifest.name}@${versions.get(entry.manifest.name)}`);

  try {
    // Rewrite and preflight EVERY package before publishing any of them, so a
    // missing version bump stops the run before a dependant can be published
    // against stale code.
    const plan = [];
    for (const entry of ordered) {
      const name = entry.manifest.name;
      const version = versions.get(name);
      staged.push(...stageDistributionFiles(entry));
      writeFileSync(entry.manifestPath, `${JSON.stringify(rewriteManifest(entry.manifest, versions, options), null, 2)}\n`);
      const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", packDestination, entry.dir]).stdout);
      const published = publishedIntegrity(name, version);
      if (published === null) {
        plan.push({ name, version, tarball: path.join(packDestination, packed.filename) });
      } else if (options.channel === "main" && published.integrity !== packed.integrity) {
        throw new Error(`${name}@${version} already exists with different contents; bump its version before publishing.`);
      } else {
        console.log(`${name}@${version} is already published; nothing to do.`);
      }
    }

    for (const { name, version, tarball } of plan) {
      const args = ["publish", tarball, "--tag", tag, `--registry=${REGISTRY}`];
      if (options.dryRun) args.push("--dry-run");
      console.log(`${options.dryRun ? "Would publish" : "Publishing"} ${name}@${version} (${tag})`);
      execFileSync("npm", args, { cwd: repoRoot, stdio: "inherit" });
    }
    console.log(`${plan.length} published, ${ordered.length - plan.length} already present. Tarballs: ${packDestination}`);
  } finally {
    for (const [manifestPath, contents] of originals) writeFileSync(manifestPath, contents);
    for (const file of staged) unlinkSync(file);
  }
}

main();
