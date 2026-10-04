// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  assertKeycloakVersionsAgree,
  assertProductionExcludesLocalProvider,
  keycloakVersionsFromSources,
} from "./keycloak-version-lockstep.mjs";

const sources = {
  pom: "<keycloak.version>26.7.3</keycloak.version>",
  localPom: "<keycloak.version>26.7.3</keycloak.version>",
  dockerfile: "FROM quay.io/keycloak/keycloak:26.7.3@sha256:" + "a".repeat(64),
  chart: 'appVersion: "26.7.3"',
};

describe("Keycloak version lockstep", () => {
  test("accepts matching compile, runtime and deployment versions", () => {
    const versions = keycloakVersionsFromSources(sources);
    expect(() => assertKeycloakVersionsAgree(versions)).not.toThrow();
  });

  test("rejects a stale Helm deployment default", () => {
    const versions = keycloakVersionsFromSources({
      ...sources,
      chart: 'appVersion: "26.5.3"',
    });
    expect(() => assertKeycloakVersionsAgree(versions)).toThrow(
      "the Helm chart deploys 26.5.3 by default",
    );
  });
});

test("the separate local SPI cannot drift from the production SPI", () => {
 expect(() => assertKeycloakVersionsAgree(keycloakVersionsFromSources({ ...sources, localPom: "<keycloak.version>26.5.3</keycloak.version>" }))).toThrow("Local Keycloak provider compiles against 26.5.3");
});
test("production builds cannot aggregate or copy the local authentication shortcut", () => {
 expect(() => assertProductionExcludesLocalProvider({ pom: sources.pom, dockerfile: "COPY pom.xml .\nCOPY src ./src\nCOPY --from=builder /build/target/main.jar /opt/keycloak/providers/" })).not.toThrow();
 for (const dockerfile of ["COPY . .", "COPY local-development ./local-development", "RUN mvn -f local-development/pom.xml package", "COPY --from=builder /build/local-development/target/provider.jar /opt/keycloak/providers/"]) expect(() => assertProductionExcludesLocalProvider({ pom: sources.pom, dockerfile })).toThrow("must not build or copy");
 expect(() => assertProductionExcludesLocalProvider({ pom: "<modules><module>local-development</module></modules>", dockerfile: sources.dockerfile })).toThrow("must not aggregate");
});
