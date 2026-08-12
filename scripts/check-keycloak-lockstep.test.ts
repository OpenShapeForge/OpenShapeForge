// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  assertKeycloakVersionsAgree,
  keycloakVersionsFromSources,
} from "./check-keycloak-lockstep.mjs";

const sources = {
  pom: "<keycloak.version>26.7.1</keycloak.version>",
  dockerfile:
    "FROM quay.io/keycloak/keycloak:26.7.1@sha256:" + "a".repeat(64),
  chart: 'appVersion: "26.7.1"',
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
