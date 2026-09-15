// SPDX-License-Identifier: BUSL-1.1

const POM_PATH = "packages/keycloak-spi/pom.xml";
const DOCKERFILE_PATH = "packages/keycloak-spi/Dockerfile";
const CHART_PATH = "deploy/helm/openshapeforge-api/charts/keycloak/Chart.yaml";

const RUNTIME_IMAGE =
  /^FROM\s+quay\.io\/keycloak\/keycloak:([^\s@]+)(?:@sha256:[0-9a-f]{64})?\s*$/m;
const POM_PROPERTY = /<keycloak\.version>([^<]+)<\/keycloak\.version>/;
const CHART_APP_VERSION = /^appVersion:\s*["']?([^\s"']+)["']?\s*$/m;

export function keycloakVersionsFromSources({ pom, dockerfile, chart }) {
  return {
    compileVersion: pom.match(POM_PROPERTY)?.[1]?.trim(),
    runtimeVersion: dockerfile.match(RUNTIME_IMAGE)?.[1]?.trim(),
    chartVersion: chart.match(CHART_APP_VERSION)?.[1]?.trim(),
  };
}

export function assertKeycloakVersionsAgree({
  compileVersion,
  runtimeVersion,
  chartVersion,
}) {
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
