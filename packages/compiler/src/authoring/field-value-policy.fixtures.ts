// SPDX-License-Identifier: BUSL-1.1
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { compileAuthoringBackendManifest, type CompileAuthoringBackendManifestOptions } from "./backend-manifest.js";
import type { CoreEntity } from "./types/authoring.js";

export function compileProtectedFieldsFixture(onCandidate?: CompileAuthoringBackendManifestOptions["onCandidate"], options: {
  configureFields?: (fields: CoreEntity["fields"]) => void;
  referentiedata?: CompileAuthoringBackendManifestOptions["referentiedata"];
} = {}) {
  const fixture = join(import.meta.dir, "__fixtures__/rowaccess");
  const directory = mkdtempSync(join(tmpdir(), "osf-field-policy-"));
  try {
    cpSync(join(fixture, "catalogs"), join(directory, "catalogs"), { recursive: true });
    mkdirSync(join(directory, "entities"));
    cpSync(join(fixture, "entities/_base.yaml"), join(directory, "entities/_base.yaml"));
    const entity = parse(readFileSync(join(fixture, "entities/classified-field.yaml"), "utf8"));
    entity.entity = "ProtectedFieldsFixture";
    entity.authorization.roles = {
      read: ["Templates.Read", "Templates.Manage"],
      create: ["Templates.Manage"], update: ["Templates.Manage"], delete: ["Templates.Manage"],
    };
    const field = (key: string, extra = {}) => ({ key, osfType: "string", label: { en: key }, ...extra });
    const authorization = { roles: { read: ["Sensitive.Read"], write: ["Sensitive.Write"] } };
    entity.fields = [
      field("label", { required: true, persisted: { column: "label", storageClass: "core" } }),
      field("explicitSecret", { authorization, required: true, persisted: { column: "explicit_secret", storageClass: "core" } }),
      { ...field("data"), osfType: "object", persisted: { column: "data", storageClass: "core" }, children: [
        field("label", { classification: { sensitivity: "pii" } }),
        field("visible", { required: true }), field("restricted", { authorization, required: true }),
        field("fixed", { immutable: true, required: true }),
        { ...field("contacts"), osfType: "object", cardinality: "collection", children: [
          field("name"), field("private", { authorization }),
        ] },
      ] },
    ];
    options.configureFields?.(entity.fields);
    writeFileSync(join(directory, "entities/protected-fields-fixture.yaml"), stringify(entity));
    return compileAuthoringBackendManifest(directory, {
      mode: "promote", entityAllowlist: ["protected-fields-fixture"],
      generatedCrudAllowlist: ["protected-fields-fixture"], schemaByModule: { core: "erp" },
      ...(options.referentiedata ? { referentiedata: options.referentiedata } : {}),
      ...(onCandidate ? { onCandidate } : {}),
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
