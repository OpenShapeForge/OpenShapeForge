// SPDX-License-Identifier: BUSL-1.1
import { test,expect } from "bun:test";
import { mkdtemp,rm,readdir,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { UsageEvent } from "@openshapeforge/plugin-runtime/diagnostics";
import {DiagnosticJournal}from"./journal.js";
const tenant=randomUUID();
const event=():UsageEvent=>({id:randomUUID(),tenantId:tenant,actorId:randomUUID(),environment:"test",receivedAt:new Date().toISOString(),completedAt:null,method:"tools/call",toolName:"sample",operationId:null,component:null,external:true,parentId:null,systemOrigin:false,client:{name:null,version:null,protocol:null,capabilities:null},metadata:{},correlation:{},arguments:{value:"original"},result:null,outcome:"unknown",error:null,httpStatus:null,isError:false,durationMs:null,responseBytes:0,delivery:"prepared",contractHash:null,taskId:null,redactions:[],truncated:[]});
test("journal isolates tenants, retains newer results and acknowledges only exact versions",async()=>{
 const path=await mkdtemp(join(tmpdir(),"osf-diagnostic-"));try{
  const j=new DiagnosticJournal(path),e=event();j.record(e);const b=await j.read(tenant);
  expect(b.events[0]?.arguments).toEqual({value:"original"});
  expect((await j.read(randomUUID())).events).toHaveLength(0);
  await expect(j.acknowledge(randomUUID(),b.receipt)).rejects.toThrow();
  j.record({...e,result:{success:true},completedAt:new Date().toISOString()});await j.acknowledge(tenant,b.receipt);
  const updated=await j.read(tenant);expect(updated.events[0]?.result).toEqual({success:true});
  await j.acknowledge(tenant,updated.receipt);expect((await j.read(tenant)).events).toHaveLength(0);
  await expect(j.acknowledge(tenant,updated.receipt)).rejects.toThrow();
 }finally{await rm(path,{recursive:true,force:true});}
});
test("the queue exposes dropped records and disk segments are private and expire",async()=>{
 const path=await mkdtemp(join(tmpdir(),"osf-diagnostic-"));try{
  const bounded=new DiagnosticJournal(path,{maxQueuedBytes:1});bounded.record(event());expect((await bounded.read(tenant)).health.dropped).toBe(1);
  const j=new DiagnosticJournal(path,{maximumAgeMs:1});j.record(event());await j.flush();
  const name=(await readdir(join(path,tenant)))[0]!;expect((await stat(join(path,tenant,name))).mode&0o777).toBe(0o600);
  await j.prune(Date.now()+1000);expect((await j.read(tenant)).events).toHaveLength(0);expect((await j.read(tenant)).health.expiredUnprocessed).toBe(1);
 }finally{await rm(path,{recursive:true,force:true});}
});
test("a second process's later immutable segment survives acknowledgement",async()=>{
 const path=await mkdtemp(join(tmpdir(),"osf-diagnostic-"));try{
  const first=new DiagnosticJournal(path),second=new DiagnosticJournal(path),e=event();first.record(e);const batch=await first.read(tenant);
  second.record({...e,result:{completed:true},delivery:'sent'});await second.flush();await first.acknowledge(tenant,batch.receipt);
  expect((await first.read(tenant)).events[0]!.result).toEqual({completed:true});
 }finally{await rm(path,{recursive:true,force:true});}
});
