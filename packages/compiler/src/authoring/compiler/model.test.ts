// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type {
  ComponentCatalog,
  Field,
  OsfTypeDefinition,
} from "../types.js";
import { resolveModelFields } from "./model.js";

const catalog: ComponentCatalog = {
  schemaVersion: 1,
  kind: "componentCatalog",
  defaults: { string: { component: "Input" } },
  viewDefaults: {},
  components: {},
};

describe("semantic renderer mapping", () => {
  test("retains authored and semantic collection bounds after normalization", () => {
    const osfTypes: Record<string, OsfTypeDefinition> = {
      boundedTags: {
        label: { en: "Tags" },
        baseType: "string",
        cardinality: { min: 1, max: 3 },
      },
    };

    const [semantic, authored] = resolveModelFields([
      { key: "tags", osfType: "boundedTags" },
      {
        key: "steps",
        osfType: "object",
        cardinality: { min: 2, max: "unbounded" },
        item: { key: "step", osfType: "object" },
      },
    ], catalog, osfTypes);

    expect(semantic).toMatchObject({
      cardinality: "collection",
      cardinalityBounds: { min: 1, max: 3 },
    });
    expect(authored).toMatchObject({
      cardinality: "collection",
      cardinalityBounds: { min: 2, max: "unbounded" },
    });
  });

  test("resolves input component and props centrally while preserving field options", () => {
    const osfTypes: Record<string, OsfTypeDefinition> = {
      referenceDataCode: {
        label: { en: "Reference value", nl: "Referentiewaarde" },
        baseType: "string",
        render: { display: "TextDisplay", input: "ReferenceSelect" },
        props: { clearable: false },
      },
    };
    const fields: Field[] = [{
      key: "status",
      osfType: "referenceDataCode",
      options: { type: "referentiedata", referentieGroep: "DOCUMENTVERSIONSTATUS" },
    }];

    expect(resolveModelFields(fields, catalog, osfTypes)[0]).toMatchObject({
      key: "status",
      render: { component: "ReferenceSelect", props: { clearable: false } },
      options: { type: "referentiedata", referentieGroep: "DOCUMENTVERSIONSTATUS" },
    });
  });

  test("uses the semantic display renderer for a read-only companion field", () => {
    const osfTypes: Record<string, OsfTypeDefinition> = {
      fileStorageLocation: {
        label: { en: "File", nl: "Bestand" },
        baseType: "string",
        render: { display: "TextDisplay", input: "FileUpload" },
        props: {
          fileNameField: "fileName",
          mimeTypeField: "mimeType",
          checksumField: "checksum",
        },
      },
    };

    expect(resolveModelFields([{
      key: "storageLocation",
      osfType: "fileStorageLocation",
      readOnly: true,
    }], catalog, osfTypes)[0]?.render).toEqual({
      component: "TextDisplay",
      props: {
        fileNameField: "fileName",
        mimeTypeField: "mimeType",
        checksumField: "checksum",
      },
    });
  });
});

test("inherits semantic choices recursively while explicit options win", () => {
  const options = { type: "static" as const, items: [{ value: "first", label: { en: "First" } }] };
  const fields = resolveModelFields([
    { key: "choice", osfType: "choice" },
    { key: "override", osfType: "choice", options: { type: "static", items: [] } },
    { key: "nested", osfType: "object", children: [{ key: "choice", osfType: "choice" }] },
    { key: "items", osfType: "string", cardinality: "collection", item: { key: "choice", osfType: "choice" } },
  ], catalog, { choice: { label: { en: "Choice" }, baseType: "string", options } });
  expect(fields[0]!.options).toEqual(options);
  expect(fields[1]!.options?.items).toEqual([]);
  expect(fields[2]!.children?.[0]?.options).toEqual(options);
  expect(fields[3]!.item?.options).toEqual(options);
});
