// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type {
  ComponentCatalog,
  Field,
  SemanticTypeDefinition,
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
  test("resolves input component and props centrally while preserving field options", () => {
    const semanticTypes: Record<string, SemanticTypeDefinition> = {
      referenceDataCode: {
        label: { en: "Reference value", nl: "Referentiewaarde" },
        valueType: "string",
        render: { display: "TextDisplay", input: "ReferenceSelect" },
        props: { clearable: false },
      },
    };
    const fields: Field[] = [{
      key: "status",
      valueType: "string",
      semanticType: "referenceDataCode",
      options: { type: "referentiedata", referentieGroep: "DOCUMENTVERSIONSTATUS" },
    }];

    expect(resolveModelFields(fields, catalog, semanticTypes)[0]).toMatchObject({
      key: "status",
      render: { component: "ReferenceSelect", props: { clearable: false } },
      options: { type: "referentiedata", referentieGroep: "DOCUMENTVERSIONSTATUS" },
    });
  });

  test("uses the semantic display renderer for a read-only companion field", () => {
    const semanticTypes: Record<string, SemanticTypeDefinition> = {
      fileStorageLocation: {
        label: { en: "File", nl: "Bestand" },
        valueType: "string",
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
      valueType: "string",
      semanticType: "fileStorageLocation",
      readOnly: true,
    }], catalog, semanticTypes)[0]?.render).toEqual({
      component: "TextDisplay",
      props: {
        fileNameField: "fileName",
        mimeTypeField: "mimeType",
        checksumField: "checksum",
      },
    });
  });
});
