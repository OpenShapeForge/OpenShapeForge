// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { OperationFailure } from "@openshapeforge/operations";
import { operationToolResult } from "../tool-results.js";
import { createTasks } from "../tasks.js";
import { executionReferenceOf } from "../execution-reference.js";
import { taskAuthorityHash } from "../task-authority.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
const reference = { kind: "workflow", ref: "run-1" };
const envelope = { data: { id: "run-1" }, operations: [], execution: reference };
const projected = () => operationToolResult({ value: envelope, resultKind: "operation-envelope", mcp: { content: [{type:"text",text:"accepted"}], structuredContent: envelope } });
const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } } };

test("the dedicated MCP projection and metadata spreads preserve a private reference, but wire JSON cannot forge it", () => {
 const result = projected();
 expect(executionReferenceOf(result)).toEqual(reference);
 expect(executionReferenceOf({ ...result, _meta: { configuration: true } })).toEqual(reference);
 expect(executionReferenceOf(JSON.parse(JSON.stringify(result)))).toBeUndefined();
});
test("read eligibility precedes retention and failure never masquerades as a failed start", async () => {
 let retained = 0; const errors: string[] = [];
 const tasks = createTasks({ store: { retain: async () => {retained++;throw new Error("must not retain");},get:async()=>undefined },
  providers: new Map([["workflow",{kind:"workflow",read:async()=>{throw new OperationFailure({code:"FORBIDDEN",message:"Follow is not permitted",retryable:false});}}]]),
  context:{execute:async()=>{throw new Error("unused");}}, onUnavailable: code=>{errors.push(code);} });
 const result = await tasks.project(projected(),meta);
 expect(result).toMatchObject({structuredContent:envelope});expect(result).not.toHaveProperty("isError",true);
 expect(retained).toBe(0);expect(errors).toEqual(["FORBIDDEN"]);
});
test("an immediate business failure preserves the start's acceptance and offers rather than replacing its result", async () => {
 let retained = 0;
 const tasks = createTasks({store:{retain:async()=>{retained++;throw new Error("must not retain");},get:async()=>undefined},
  providers:new Map([["workflow",{kind:"workflow",read:async()=>({status:"completed" as const,updatedAt:new Date().toISOString(),result:{data:{status:"failed"},operations:[]},isError:true})}]]),
  context:{execute:async()=>{throw new Error("unused");}} });
 const original=projected();expect(await tasks.project(original,meta)).toBe(original);expect(retained).toBe(0);
});
test("authority binding rejects unknown bearer clients, separates scopes and survives API-key rotation", () => {
 const s: TrustedSessionContext={tenantId:"tenant",userId:"actor",issuer:"issuer",roles:[],groups:[],scope:"tenant",credential:"bearer"};
 expect(taskAuthorityHash(s)).toBeUndefined();
 const hash=taskAuthorityHash({...s,oauthClientId:"client-a",oauthScopes:["b","a"]});
 expect(hash).toBe(taskAuthorityHash({...s,oauthClientId:"client-a",oauthScopes:["a","b"]}));
 expect(hash).not.toBe(taskAuthorityHash({...s,oauthClientId:"client-b",oauthScopes:["a","b"]}));
 expect(hash).not.toBe(taskAuthorityHash({...s,oauthClientId:"client-a",oauthScopes:["a"]}));
 const key={...s,credential:"api-key" as const,appPrincipal:{integrationId:"integration",credentialId:"key-1"}};
 expect(taskAuthorityHash(key)).toBe(taskAuthorityHash({...key,appPrincipal:{integrationId:"integration",credentialId:"key-2"}}));
});
