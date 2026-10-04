// SPDX-License-Identifier: BUSL-1.1

const LOCAL_POM_PATH = "packages/keycloak-spi/local-development/pom.xml";
const POM_PATH = "packages/keycloak-spi/pom.xml";
const DOCKERFILE_PATH = "packages/keycloak-spi/Dockerfile";
const CHART_PATH = "deploy/helm/openshapeforge-api/charts/keycloak/Chart.yaml";

const RUNTIME_IMAGE =
  /^FROM\s+quay\.io\/keycloak\/keycloak:([^\s@]+)(?:@sha256:[0-9a-f]{64})?\s*$/m;
const POM_PROPERTY = /<keycloak\.version>([^<]+)<\/keycloak\.version>/;
const CHART_APP_VERSION = /^appVersion:\s*["']?([^\s"']+)["']?\s*$/m;

export function keycloakVersionsFromSources({ pom, localPom, dockerfile, chart }) {
  return {
    localCompileVersion: localPom.match(POM_PROPERTY)?.[1]?.trim(),
    compileVersion: pom.match(POM_PROPERTY)?.[1]?.trim(),
    runtimeVersion: dockerfile.match(RUNTIME_IMAGE)?.[1]?.trim(),
    chartVersion: chart.match(CHART_APP_VERSION)?.[1]?.trim(),
  };
}

export function assertKeycloakVersionsAgree({
  compileVersion,
  localCompileVersion,
  runtimeVersion,
  chartVersion,
}) {
  if (!compileVersion) {
    throw new Error(`${POM_PATH}: no <keycloak.version> property found.`);
  }
  if (!localCompileVersion) throw new Error(`${LOCAL_POM_PATH}: no <keycloak.version> property found.`);
  if (compileVersion !== localCompileVersion) throw new Error(`Local Keycloak provider compiles against ${localCompileVersion}, parent SPI against ${compileVersion}. Update both Maven declarations together.`);
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

/** The optional authentication shortcut must never enter a published image. */
export function assertProductionExcludesLocalProvider({ pom, dockerfile }) {
  if (/<module>\s*local-development\s*<\/module>/.test(pom)) throw new Error("Production SPI must not aggregate the local-development module.");
  for (const line of dockerfile.split("\n")) {
    if (!/^\s*(COPY|RUN)\s/.test(line)) continue;
    if (/local-development|openshapeforge-local-login/.test(line) || /^\s*COPY\s+(?:--\S+\s+)*(?:\.|\.\/|\*)\s/.test(line))
      throw new Error("Production Dockerfile must not build or copy the local-development provider.");
  }
}
