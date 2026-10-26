// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { ReadProgressRuntime } from "./read-progress.js";
import type { RuntimeOperationDefinition, RuntimeReadProgress } from "@openshapeforge/plugin-runtime";
const read = (id = "example.tasks.list"): RuntimeOperationDefinition => ({id, intent:"invoke", name:"Read", description:"Read", input:{}, output:{}, effects:{data:"read",external:"read"}, reliability:{idempotency:{mode:"natural"}}});
test("same request reports tasks and contacts; no observer leaves the final value unchanged", async () => {
  const runtime = new ReadProgressRuntime<object>(() => {}), session = {}, updates: RuntimeReadProgress[] = [];
  for (const id of ["example.tasks.list", "example.contacts.list"]) {
    const value = await runtime.observe(session, async x => {updates.push(x);}, () => runtime.operation(session, read(id), undefined, async () => {
      expect(await runtime.report(session,{data:{items:[{id:"a"}]}})).toBe(true);
      return {items:[{id:"a"},{id:"b"}]};
    }));
    expect(value.items).toHaveLength(2);
  }
  expect(updates.map(x=>x.operationId)).toEqual(["example.tasks.list","example.contacts.list"]);
  expect(await runtime.operation(session,read(),undefined,()=>runtime.report(session,{data:{items:[]}}))).toBe(false);
});
test("rejects foreign sessions, nested operations, writes, aborted and expired callbacks", async () => {
  const runtime = new ReadProgressRuntime<object>(()=>{}), session = {}, abort = new AbortController();
  let later: () => Promise<boolean> = async()=>true;
  await runtime.observe(session,async()=>{},()=>runtime.operation(session,read(),abort.signal,async()=>{
    expect(await runtime.report({}, {data:{items:[]}})).toBe(false);
    await runtime.operation(session,read("nested"),undefined,async()=>expect(await runtime.report(session,{data:{items:[]}})).toBe(false));
    later=()=>runtime.report(session,{data:{items:[]}});
    abort.abort(); expect(await later()).toBe(false);
  }));
  expect(await later()).toBe(false);
  await runtime.observe(session,async()=>{},()=>runtime.operation(session,{...read(),effects:{data:"write",external:"none"}},undefined,async()=>expect(await runtime.report(session,{data:{items:[]}})).toBe(false)));
});
test("concurrent observers are isolated and snapshots copied and bounded; failed delivery retains final result", async()=>{
  const runtime=new ReadProgressRuntime<object>(data=>{if(JSON.stringify(data)?.includes("accessToken"))throw Error("secret");});
  await Promise.all([{},{}].map(async session=>{
    const seen:RuntimeReadProgress[]=[];
    await runtime.observe(session,async value=>{seen.push(value);},()=>runtime.operation(session,read(),undefined,async()=>{
      const snapshot={items:[{id:"a"}]};
      expect(await runtime.report(session,{data:snapshot})).toBe(true); snapshot.items[0]!.id="b";
      expect((seen[0]!.data!.items as {id:string}[])[0]!.id).toBe("a");
      expect(await runtime.report(session,{data:{accessToken:"hidden"}})).toBe(false);
      expect(await runtime.report(session,{data:{text:"x".repeat(70_000)}})).toBe(false);
      expect(seen[0]!.sequence).toBe(1);
    }));
  }));
  const session={}; expect(await runtime.observe(session,async()=>{throw Error("offline");},()=>runtime.operation(session,read(),undefined,async()=>{expect(await runtime.report(session,{message:"loading"})).toBe(false);return "final";}))).toBe("final");
});
test("sibling roots remain eligible after a preliminary operation; concurrent report attempts stay bounded",async()=>{
  const runtime=new ReadProgressRuntime<object>(value=>{if(JSON.stringify(value)?.includes("accessToken"))throw Error("secret");}),session={},seen:RuntimeReadProgress[]=[];
  await runtime.observe(session,async x=>{seen.push(x);},async()=>{
    await runtime.operation(session,read("preliminary"),undefined,async()=>{});
    await Promise.all(["tasks","contacts"].map(id=>runtime.operation(session,read(id),undefined,async()=>{
      await runtime.report(session,{data:{items:[{id}]}});
    })));
    await runtime.operation(session,read(),undefined,async()=>{
      await Promise.all(Array.from({length:30},()=>runtime.report(session,{message:"reading"})));
    });
  });
  expect(seen).toHaveLength(20);expect(seen.slice(0,2).map(x=>x.operationId).sort()).toEqual(["contacts","tasks"]);
});
test("abort releases a stalled delivery and serialization cannot change the data contract",async()=>{
  const runtime=new ReadProgressRuntime<object>(()=>{}),session={},abort=new AbortController();
  await runtime.observe(session,async()=>new Promise(()=>{}),()=>runtime.operation(session,read(),abort.signal,async()=>{
    const pending=runtime.report(session,{data:{items:[]}});abort.abort();expect(await pending).toBe(false);
  }));
  await runtime.observe(session,async()=>{throw Error("must not emit");},()=>runtime.operation(session,read(),undefined,async()=>{
    expect(await runtime.report(session,{data:{toJSON:()=>[]}})).toBe(false);
    expect(await runtime.report(session,{data:{toJSON:()=>null}})).toBe(false);
  }));
});
test("observer cancellation is inherited only by a top-level read, never an enclosing write",async()=>{
  const runtime=new ReadProgressRuntime<object>(()=>{}),session={},abort=new AbortController();
  await runtime.observe(session,async()=>{},async()=>{
    await runtime.operation(session,read(),undefined,async signal=>expect(signal).toBe(abort.signal));
    await runtime.operation(session,{...read(),effects:{data:"write",external:"none"}},undefined,async signal=>{
      expect(signal).toBeUndefined();
      await runtime.operation(session,read("nested"),signal,async nestedSignal=>expect(nestedSignal).toBeUndefined());
    });
  },abort.signal);
});
test("a stalled optional notification cannot delay the final read indefinitely",async()=>{
  const runtime=new ReadProgressRuntime<object>(()=>{},5),session={};
  expect(await runtime.observe(session,async()=>new Promise(()=>{}),()=>runtime.operation(session,read(),undefined,async()=>{
    expect(await runtime.report(session,{data:{items:[]}})).toBe(false);return "final";
  }))).toBe("final");
});
