// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { createToolDiscovery, readToolPins } from "../tool-discovery.js";
const text = (value: CallToolResult | undefined) => JSON.parse((value!.content[0] as {text:string}).text);
const tool = (name: string): Tool => ({name, description: `Find records with ${name}`,inputSchema:{type:"object",required:["record"],properties:{record:{type:"string"}}},annotations:{readOnlyHint:true}});
function fixture() {
  let available = Array.from({length:125},(_,i)=>tool(`record_${String(i).padStart(3,"0")}`));
  const calls: unknown[]=[];
  const discovery=createToolDiscovery({pins:new Set(["record_001"]),available:async()=>available,call:async(name,args)=>{calls.push({name,args});return {content:[{type:"text",text:JSON.stringify({ok:true})}]};}});
  return {discovery,calls,revoke:()=>{available=[];}};
}
describe("pinned advertisement and authorized discovery",()=>{
  test("an explicit pin list advertises only pins and discovery",async()=>{
    const {discovery}=fixture();
    expect((await discovery.listed()).map(t=>t.name)).toEqual(["osf_search_tools","osf_read_tool","osf_call_tool","record_001"]);
  });
  test("search pages beyond 100 with no input-schema flood",async()=>{
    const {discovery}=fixture();let after: string | undefined;const found:string[]=[];
    do{const page=text(await discovery.handle("osf_search_tools",{query:"record",limit:50,...(after?{after}:{})}));found.push(...page.tools.map((t:Tool)=>t.name));expect(page.tools.every((t:Tool)=>!t.inputSchema)).toBe(true);after=page.nextCursor;}while(after);
    expect(found.length).toBe(125);expect(new Set(found).size).toBe(125);
  });
  test("full schema and normal execution are available for unpinned tools",async()=>{
    const {discovery,calls}=fixture();
    expect(text(await discovery.handle("osf_read_tool",{name:"record_124"})).inputSchema.required).toEqual(["record"]);
    expect(text(await discovery.handle("osf_call_tool",{name:"record_124",arguments:{record:"example"}}))).toEqual({ok:true});
    expect(calls).toEqual([{name:"record_124",args:{record:"example"}}]);
  });
  test("revocation after discovery prevents reads and calls",async()=>{
    const {discovery,revoke,calls}=fixture();await discovery.handle("osf_read_tool",{name:"record_124"});revoke();
    expect(text(await discovery.handle("osf_search_tools",{})).tools).toEqual([]);
    expect((await discovery.handle("osf_read_tool",{name:"record_124"}))!.isError).toBe(true);
    expect((await discovery.handle("osf_call_tool",{name:"record_124",arguments:{}}))!.isError).toBe(true);expect(calls).toEqual([]);
  });
  test("unknown and unavailable targets have identical responses",async()=>{
    const {discovery,revoke}=fixture();revoke();
    expect(await discovery.handle("osf_read_tool",{name:"record_124"})).toEqual(await discovery.handle("osf_read_tool",{name:"does_not_exist"}));
  });
  test("rejects recursive calls, identity overrides and invalid pagination",async()=>{
    const {discovery,calls}=fixture();
    for(const args of [{name:"osf_call_tool",arguments:{}},{name:"record_001",arguments:{},tenantId:"other"},{name:"record_001",arguments:[]}]) expect((await discovery.handle("osf_call_tool",args))!.isError).toBe(true);
    expect((await discovery.handle("osf_search_tools",{limit:0}))!.isError).toBe(true);
    expect((await discovery.handle("osf_search_tools",{limit:51}))!.isError).toBe(true);
    expect(calls).toEqual([]);
  });
  test("pinning is opt-in, bounded, and malformed configuration fails closed",()=>{
    expect(readToolPins(undefined)).toBeUndefined();expect(readToolPins("[]")?.size).toBe(0);
    for(const v of ['{}','[null]','["bad name"]','not-json',JSON.stringify(Array(61).fill("tool"))]) expect(()=>readToolPins(v)).toThrow();
  });
  test("discovery wrappers cannot shadow an existing authorized tool",async()=>{
    const d=createToolDiscovery({pins:new Set(),available:async()=>[tool("osf_search_tools")],call:async()=>({content:[]})});
    expect(d.listed()).rejects.toThrow("collision");
  });
});
