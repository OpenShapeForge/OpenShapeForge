#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
//
// The Keycloak SPI compiles against <keycloak.version> in pom.xml and runs
// inside the base image named in the same directory's Dockerfile. Those are two
// independent version declarations for one runtime.
//
// It matters more here than the usual "keep versions tidy": the SPI calls
// internal server APIs — AppAuthManager.BearerTokenAuthenticator,
// OrganizationProvider, OrganizationModel — which Keycloak does not cover by any
// cross-release compatibility guarantee. Compile against 26.1.0, deploy onto
// 26.5.3, and a changed signature does not fail the build; it throws
// NoSuchMethodError the first time the endpoint is hit, taking the
// identity-configuration SPI down (issue #14). Worse, a changed auth default in
// requireAdminBearer would alter the security posture with nothing to catch it.
//
// Two Dependabot ecosystems move these lines independently (maven for the pom,
// docker for the Dockerfile), so drift is the expected steady state without a
// gate. That is also why this is a check rather than a shared build ARG: a check
// keeps both declarations literal and Dependabot-updatable, and reports the
// mismatch instead of silently resolving it.
//
// Since #488 the image also layers third-party provider jars (the Apple
// Sign-in provider) whose compatibility is stated per Keycloak minor and whose
// bytes are pinned by SHA-512. provider-compatibility.json records, for each
// jar, the version + checksum in force and the Keycloak version they were
// reviewed against. A Keycloak bump that leaves that record untouched fails
// here, so nobody can move the base image without re-deciding whether the
// provider still fits; a Dockerfile pin that disagrees with the record fails
// too, so the record cannot silently describe bytes the image does not ship.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POM_PATH = "packages/keycloak-spi/pom.xml";
const DOCKERFILE_PATH = "packages/keycloak-spi/Dockerfile";
const COMPAT_PATH = "packages/keycloak-spi/provider-compatibility.json";

// quay.io/keycloak/keycloak:26.5.3, with or without an @sha256: digest pin.
const RUNTIME_IMAGE =
  /^FROM\s+quay\.io\/keycloak\/keycloak:([^\s@]+)(?:@sha256:[0-9a-f]{64})?\s*$/m;
const POM_PROPERTY = /<keycloak\.version>([^<]+)<\/keycloak\.version>/;

const pom = await readFile(join(REPO_ROOT, POM_PATH), "utf8");
const dockerfile = await readFile(join(REPO_ROOT, DOCKERFILE_PATH), "utf8");
const compat = JSON.parse(await readFile(join(REPO_ROOT, COMPAT_PATH), "utf8"));

const compileVersion = pom.match(POM_PROPERTY)?.[1]?.trim();
const runtimeVersion = dockerfile.match(RUNTIME_IMAGE)?.[1]?.trim();

const failures = [];

if (!compileVersion) {
  failures.push(`${POM_PATH}: no <keycloak.version> property found.`);
}
if (!runtimeVersion) {
  failures.push(
    `${DOCKERFILE_PATH}: no 'FROM quay.io/keycloak/keycloak:<tag>' line found.`,
  );
}

if (compileVersion && runtimeVersion && compileVersion !== runtimeVersion) {
  failures.push(
    `Keycloak version drift: the SPI compiles against ${compileVersion} ` +
      `(${POM_PATH}) but runs on ${runtimeVersion} (${DOCKERFILE_PATH}).\n\n` +
      `The SPI uses internal Keycloak APIs with no cross-release compatibility ` +
      `guarantee, so this does not fail the build — it fails at the first ` +
      `request with NoSuchMethodError. Set both to the same version.`,
  );
}

// --- Third-party provider jars -------------------------------------------

function dockerfileArg(name) {
  const match = dockerfile.match(new RegExp(`^ARG\\s+${name}=(\\S+)\\s*$`, "m"));
  return match?.[1]?.trim();
}

// Strict MAJOR.MINOR.PATCH. Anything else — a rebuild suffix such as
// `26.5.0-0`, a `latest` tag, a two-part version — is rejected up front rather
// than parsed leniently: `Number("0-0")` is NaN, and a NaN comparison would
// pass the minimum-version guard below silently.
const STRICT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function parseStrictVersion(value, where) {
  const match = STRICT_VERSION.exec(value);
  if (!match) {
    failures.push(
      `${where}: version "${value}" is not a strict MAJOR.MINOR.PATCH version, so it cannot be compared against a minimum Keycloak version.`,
    );
    return undefined;
  }
  return match.slice(1, 4).map(Number);
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    const d = a[i] - b[i];
    if (d !== 0) return d;
  }
  return 0;
}

if (typeof compat.keycloak !== "string" || !compat.keycloak) {
  failures.push(`${COMPAT_PATH}: missing "keycloak" (the version the provider pins were reviewed against).`);
} else if (runtimeVersion && compat.keycloak !== runtimeVersion) {
  failures.push(
    `Keycloak moved to ${runtimeVersion} (${DOCKERFILE_PATH}) but ${COMPAT_PATH} ` +
      `still records the provider jars as reviewed against ${compat.keycloak}.\n\n` +
      `Third-party provider jars state compatibility per Keycloak release and ` +
      `their checksums are pinned. Before bumping Keycloak: confirm each ` +
      `provider's compatibility statement covers ${runtimeVersion}, bump the ` +
      `provider (version + SHA-512, in the Dockerfile ARGs AND this record) if ` +
      `it does not, then set "keycloak" here to ${runtimeVersion}. See ` +
      `docs/identity-providers.md.`,
  );
}

const providers = compat.providers && typeof compat.providers === "object" ? compat.providers : {};
if (Object.keys(providers).length === 0) {
  failures.push(`${COMPAT_PATH}: no providers recorded; the Dockerfile layers at least one.`);
}

for (const [name, entry] of Object.entries(providers)) {
  const where = `${COMPAT_PATH} → providers.${name}`;
  for (const key of ["version", "sha512", "artifact", "source", "license", "minimumKeycloak", "dockerfileArgs"]) {
    if (entry[key] === undefined || entry[key] === "") {
      failures.push(`${where}: missing "${key}".`);
    }
  }
  if (typeof entry.sha512 === "string" && !/^[0-9a-f]{128}$/.test(entry.sha512)) {
    failures.push(`${where}: "sha512" is not a 128-hex-character SHA-512 digest.`);
  }
  const args = entry.dockerfileArgs ?? {};
  const dfVersion = args.version ? dockerfileArg(args.version) : undefined;
  const dfSha = args.sha512 ? dockerfileArg(args.sha512) : undefined;
  if (args.version && dfVersion === undefined) {
    failures.push(`${DOCKERFILE_PATH}: no 'ARG ${args.version}=<version>' line for ${name}.`);
  } else if (dfVersion !== undefined && dfVersion !== entry.version) {
    failures.push(
      `${name}: ${DOCKERFILE_PATH} pins version ${dfVersion} (ARG ${args.version}) but ${where} records ${entry.version}. Bump both together.`,
    );
  }
  if (args.sha512 && dfSha === undefined) {
    failures.push(`${DOCKERFILE_PATH}: no 'ARG ${args.sha512}=<sha512>' line for ${name}.`);
  } else if (dfSha !== undefined && dfSha !== entry.sha512) {
    failures.push(
      `${name}: ${DOCKERFILE_PATH} pins a SHA-512 (ARG ${args.sha512}) that differs from ${where}. The record must describe the bytes the image ships.`,
    );
  }
  if (typeof entry.artifact === "string" && typeof entry.version === "string" && !entry.artifact.includes(entry.version)) {
    failures.push(`${where}: "artifact" ${entry.artifact} does not name version ${entry.version}.`);
  }
  if (runtimeVersion && typeof entry.minimumKeycloak === "string") {
    const runtime = parseStrictVersion(runtimeVersion, `${DOCKERFILE_PATH} (Keycloak base image tag)`);
    const minimum = parseStrictVersion(entry.minimumKeycloak, `${where} → minimumKeycloak`);
    if (runtime && minimum && compareVersions(runtime, minimum) < 0) {
      failures.push(
        `${name} ${entry.version} requires Keycloak >= ${entry.minimumKeycloak}, but the image runs ${runtimeVersion}.`,
      );
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure + "\n");
  process.exit(1);
}

console.log(
  `Keycloak SPI compiles against and runs on ${compileVersion} (pom.xml and Dockerfile agree).`,
);
for (const [name, entry] of Object.entries(providers)) {
  console.log(
    `Provider jar ${name} ${entry.version} (${entry.license}) pinned by SHA-512 and reviewed against Keycloak ${compat.keycloak}.`,
  );
}
