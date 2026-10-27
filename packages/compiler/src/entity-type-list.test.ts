// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { collectAuthoredEntityPluginOperations, assertOperationRuntimeModules } from "./generate-operations.js";
import type { CompiledEntityInfo } from "./plugins.js";

const context = { repoRoot: ".", authoringDir: ".", webPresent: true };
test("entity type discovery is a trusted canonical native read operation with authored labels", () => {
  const entities = [{ contract: {
    entity: { name: "Example", title: "Example", labels: { en: "Example", nl: "Voorbeeld" } },
    authorization: { roles: { read: ["Example.Read"] } },
    model: { fields: [{ options: { type: "dynamic", source: "entityTypes.list" } }] },
  } }] as unknown as Pick<CompiledEntityInfo, "contract">[];
  const operations = collectAuthoredEntityPluginOperations(entities, context);
  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({ key: "entityTypes.list", auth: { mode: "session", roles: ["Example.Read"] }, effects: { data: "read", external: "none" }, implementation: { type: "entity-type-list", labels: { Example: { nl: "Voorbeeld" } } } });
  expect(() => assertOperationRuntimeModules(operations, [])).not.toThrow();
  expect(() => assertOperationRuntimeModules([{ ...operations[0]! }], [])).toThrow("unverified");
});

test('application search is a verified core read with compiler-owned searchable fields',()=>{
 const entities=[{contract:{entity:{name:'Example',title:'Example',labels:{en:'Examples',nl:'Voorbeelden'},filterField:'name'},
 authorization:{roles:{read:['Example.Read']}},entityOperations:{list:{id:'Example.list'},get:{id:'Example.get'}},
 model:{fields:[{key:'name',baseType:'string'},{key:'description',baseType:'string'}],relationships:[]}}}] as any;
 const operations=collectAuthoredEntityPluginOperations(entities,context);
 const search=operations.find(op=>op.key==='application.search')!;
 expect(search.implementation).toMatchObject({type:'application-search',sources:[{entity:'Example',field:'name',descriptionField:'description'}]});
 expect(()=>assertOperationRuntimeModules(operations,[])).not.toThrow();
});
