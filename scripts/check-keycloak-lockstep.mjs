#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
//
// The Keycloak SPI compiles against <keycloak.version> in pom.xml and runs
// inside the base image named in the same directory's Dockerfile and is deployed
// by default through the vendored Helm chart. Those are three independent
// version declarations for one runtime.
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
// Two Dependabot ecosystems move the pom and Dockerfile independently (maven
// and docker), while the Helm appVersion is maintained by this repository. Drift
// is therefore the expected steady state without a gate. That is also why this
// is a check rather than a shared build ARG: a check keeps all declarations
// literal and update-tool-friendly, and reports the mismatch instead of silently
// resolving it.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POM_PATH = "packages/keycloak-spi/pom.xml";
const DOCKERFILE_PATH = "packages/keycloak-spi/Dockerfile";
const CHART_PATH = "deploy/helm/openshapeforge-api/charts/keycloak/Chart.yaml";

// quay.io/keycloak/keycloak:<version>, with or without an @sha256: digest pin.
const RUNTIME_IMAGE =
  /^FROM\s+quay\.io\/keycloak\/keycloak:([^\s@]+)(?:@sha256:[0-9a-f]{64})?\s*$/m;
const POM_PROPERTY = /<keycloak\.version>([^<]+)<\/keycloak\.version>/;
const CHART_APP_VERSION = /^appVersion:\s*["']?([^\s"']+)["']?\s*$/m;

export function keycloakVersionsFromSources({
  pom,
  dockerfile,
  chart,
}) {
  return {
    compileVersion: pom.match(POM_PROPERTY)?.[1]?.trim(),
    runtimeVersion: dockerfile.match(RUNTIME_IMAGE)?.[1]?.trim(),
    chartVersion: chart.match(CHART_APP_VERSION)?.[1]?.trim(),
  };
}

export function assertKeycloakVersionsAgree(versions) {
  const { compileVersion, runtimeVersion, chartVersion } = versions;
  if (!compileVersion) {
    throw new Error(`${POM_PATH}: no <keycloak.version> property found.`);
  }
  if (!runtimeVersion) {
    throw new Error(
      `${DOCKERFILE_PATH}: no 'FROM quay.io/keycloak/keycloak:<tag>' line found.`,
    );
  }
  if (!chartVersion) {
    throw new Error(`${CHART_PATH}: no appVersion found.`);
  }

  if (compileVersion !== runtimeVersion || compileVersion !== chartVersion) {
    throw new Error(
      `Keycloak version drift: the SPI compiles against ${compileVersion} ` +
        `(${POM_PATH}), the image runs ${runtimeVersion} (${DOCKERFILE_PATH}), ` +
        `and the Helm chart deploys ${chartVersion} by default (${CHART_PATH}).\n\n` +
        `The SPI uses internal Keycloak APIs with no cross-release compatibility ` +
        `guarantee, so this can survive the build and fail at the first request. ` +
        `Set all three to the same version.`,
    );
  }
}

if (import.meta.main) {
  const [pom, dockerfile, chart] = await Promise.all([
    readFile(join(REPO_ROOT, POM_PATH), "utf8"),
    readFile(join(REPO_ROOT, DOCKERFILE_PATH), "utf8"),
    readFile(join(REPO_ROOT, CHART_PATH), "utf8"),
  ]);

  const versions = keycloakVersionsFromSources({ pom, dockerfile, chart });
  try {
    assertKeycloakVersionsAgree(versions);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.log(
    `Keycloak SPI compiles against, runs on and deploys ${versions.compileVersion} ` +
      `(pom.xml, Dockerfile and Helm chart agree).`,
  );
}
