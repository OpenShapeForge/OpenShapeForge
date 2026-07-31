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

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POM_PATH = "packages/keycloak-spi/pom.xml";
const DOCKERFILE_PATH = "packages/keycloak-spi/Dockerfile";

// quay.io/keycloak/keycloak:26.5.3, with or without an @sha256: digest pin.
const RUNTIME_IMAGE =
  /^FROM\s+quay\.io\/keycloak\/keycloak:([^\s@]+)(?:@sha256:[0-9a-f]{64})?\s*$/m;
const POM_PROPERTY = /<keycloak\.version>([^<]+)<\/keycloak\.version>/;

const pom = await readFile(join(REPO_ROOT, POM_PATH), "utf8");
const dockerfile = await readFile(join(REPO_ROOT, DOCKERFILE_PATH), "utf8");

const compileVersion = pom.match(POM_PROPERTY)?.[1]?.trim();
const runtimeVersion = dockerfile.match(RUNTIME_IMAGE)?.[1]?.trim();

if (!compileVersion) {
  console.error(`${POM_PATH}: no <keycloak.version> property found.`);
  process.exit(1);
}
if (!runtimeVersion) {
  console.error(
    `${DOCKERFILE_PATH}: no 'FROM quay.io/keycloak/keycloak:<tag>' line found.`,
  );
  process.exit(1);
}

if (compileVersion !== runtimeVersion) {
  console.error(
    `Keycloak version drift: the SPI compiles against ${compileVersion} ` +
      `(${POM_PATH}) but runs on ${runtimeVersion} (${DOCKERFILE_PATH}).\n\n` +
      `The SPI uses internal Keycloak APIs with no cross-release compatibility ` +
      `guarantee, so this does not fail the build — it fails at the first ` +
      `request with NoSuchMethodError. Set both to the same version.`,
  );
  process.exit(1);
}

console.log(
  `Keycloak SPI compiles against and runs on ${compileVersion} (pom.xml and Dockerfile agree).`,
);
