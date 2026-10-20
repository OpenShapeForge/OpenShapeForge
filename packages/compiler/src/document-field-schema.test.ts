// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { operationReferenceKeyword } from "@openshapeforge/operations";
import { compiledFieldSchema } from "./field-json-schema.js";

test("Document restrictions are discoverable through the shared reference annotation", () => {
 const document = {content:"file" as const,mimeTypes:["image/png"],maxBytes:100};
 const schema = compiledFieldSchema({key:"logo",osfType:"Document",baseType:"string",cardinality:"single",required:false,label:{en:"Logo"},render:{component:"EntityReferenceSelect"},document,relationship:{kind:"belongsTo",entity:"document",target:"Document"}});
 expect(schema["x-osf-reference"]).toEqual({entity:"Document",valueField:"id",document});
 const ajv = new Ajv2020.default({strict:false});ajv.addKeyword(operationReferenceKeyword);
 expect(()=>ajv.compile(schema)).not.toThrow();
});
