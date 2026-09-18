// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  buildFieldAuthoringRegistry,
  renderFieldAuthoringRegistry,
} from "./field-authoring-registry.js";

describe("field authoring registry", () => {
  test("preserves canonical catalog metadata without editor-specific normalization", () => {
    const registry = buildFieldAuthoringRegistry({
      fieldAuthoringProfiles: {
        exampleProfile: {
          label: { nl: "Voorbeeld", en: "Example" },
          controls: { label: true },
          futureProfileProperty: { enabled: true },
        },
      },
      osfTypes: {
        exampleType: {
          label: { nl: "Voorbeeld", en: "Example" },
          valueType: "string",
          kind: "scalar",
          props: { futureSemanticProperty: true },
        },
      },
      referentiedataCatalog: {
        schemaVersion: 1,
        kind: "coreReferentiedataCatalog",
        groepen: {
          EXAMPLE: {
            description: "Keep group metadata",
            futureGroupProperty: true,
            items: [{
              value: "one",
              label: { nl: "Een", en: "One", fr: "Un" },
              futureItemProperty: 1,
            }],
          },
        },
      },
    });

    expect(JSON.parse(renderFieldAuthoringRegistry(registry))).toEqual({
      version: 1,
      fieldAuthoringProfiles: {
        exampleProfile: {
          label: { nl: "Voorbeeld", en: "Example" },
          controls: { label: true },
          futureProfileProperty: { enabled: true },
        },
      },
      osfTypes: {
        exampleType: {
          label: { nl: "Voorbeeld", en: "Example" },
          valueType: "string",
          kind: "scalar",
          props: { futureSemanticProperty: true },
        },
      },
      referentiedata: {
        EXAMPLE: {
          description: "Keep group metadata",
          futureGroupProperty: true,
          items: [{
            value: "one",
            label: { nl: "Een", en: "One", fr: "Un" },
            futureItemProperty: 1,
          }],
        },
      },
    });
  });
});
