// SPDX-License-Identifier: BUSL-1.1
import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ContractSnapshot, RuntimeMcpDiagnosticBatch, UsageEvent } from "@openshapeforge/plugin-runtime/diagnostics";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Entry = { event: UsageEvent; snapshots: ContractSnapshot[] };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** Immutable event-version segments: acknowledgement cannot remove a later result, even across processes. */
export class DiagnosticJournal {
  readonly collectorId=randomUUID();
  readonly since=new Date().toISOString();
  private tail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private counters = new Map<string,{dropped:number;writeFailures:number;expiredUnprocessed:number}>();
  private health(tenant:string|null) {
    const key=tenant??'unassigned'; let value=this.counters.get(key);
    if(!value){value={dropped:0,writeFailures:0,expiredUnprocessed:0};this.counters.set(key,value);}
    return value;
  }
  private receipts = new Map<string,{ tenant: string; files: { path:string; hash:string }[]; expires:number }>();
  constructor(readonly directory: string, readonly options: {maxQueuedBytes?:number; maximumAgeMs?:number; maximumDiskBytes?:number} = {}) {}
  record(event: UsageEvent, snapshots: readonly ContractSnapshot[] = []): void {
    if (!uuid.test(event.id) || (event.tenantId !== null && !uuid.test(event.tenantId)) || snapshots.some(s => s.tenantId !== event.tenantId)) { this.health(event.tenantId).dropped++; return; }
    // Serialization happens now: subsequent updates of the mutable observer cannot alter queued data.
    let data: string;
    try { data = JSON.stringify({event,snapshots}); } catch { this.health(event.tenantId).dropped++; return; }
    const bytes = Buffer.byteLength(data);
    if (bytes + this.queuedBytes > (this.options.maxQueuedBytes ?? 32*1024*1024)) { this.health(event.tenantId).dropped++; return; }
    this.queuedBytes += bytes;
    this.tail = this.tail.then(async()=>{
      const folder = join(this.directory,event.tenantId ?? "unassigned");
      await mkdir(folder,{recursive:true,mode:0o700});
      const path = join(folder,`${event.id}.${randomUUID()}.json`), temporary = `${path}.tmp`;
      try {
        const file = await open(temporary,"wx",0o600);
        try { await file.writeFile(data,"utf8"); } finally { await file.close(); }
        await rename(temporary,path);
      } finally { await unlink(temporary).catch(()=>{}); }
    }).catch(()=>{this.health(event.tenantId).writeFailures++;this.health(event.tenantId).dropped++;}).finally(()=>{this.queuedBytes-=bytes;});
  }
  async flush(): Promise<void> { await this.tail; }
  async read(tenant: string, limit = 250): Promise<RuntimeMcpDiagnosticBatch> {
    if (!uuid.test(tenant)) throw Error("Invalid verified diagnostic tenant.");
    if (!Number.isInteger(limit) || limit<1 || limit>1000) throw Error("Invalid diagnostic batch size.");
    await this.flush();
    const folder=join(this.directory,tenant), events:UsageEvent[]=[], snapshots:ContractSnapshot[]=[], files:{path:string;hash:string}[]=[];
    let batchBytes=0;
    const names=await readdir(folder).catch((error)=>{if(error.code==='ENOENT')return [];throw error;});
    for(const name of names.filter(n=>/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.json$/i.test(n)).sort()) {
      if(events.length>=limit)break;
      const path=join(folder,name); let text:string;
      try{text=await readFile(path,"utf8");}catch(error){if((error as {code?:string}).code==='ENOENT')continue;throw error;}
      const bytes=Buffer.byteLength(text);if(events.length>0&&batchBytes+bytes>16*1024*1024)break;batchBytes+=bytes;
      const entry=JSON.parse(text) as Entry;
      if(entry.event.tenantId!==tenant||entry.snapshots.some(s=>s.tenantId!==tenant))throw Error("Diagnostic tenant binding mismatch.");
      events.push(entry.event); snapshots.push(...entry.snapshots);files.push({path,hash:digest(text)});
    }
    const receipt=randomUUID(), now=Date.now();
    for(const [key,value]of this.receipts)if(value.expires<=now)this.receipts.delete(key);
    if(this.receipts.size>=10000)throw Error("Diagnostic receipts are at capacity.");
    this.receipts.set(receipt,{tenant,files,expires:now+10*60*1000});
    return {receipt,events,snapshots,health:{collectorId:this.collectorId,since:this.since,...this.health(tenant)}};
  }
  async acknowledge(tenant:string,receipt:string):Promise<void>{
    const batch=this.receipts.get(receipt);
    if(!batch||batch.tenant!==tenant||batch.expires<=Date.now())throw Error("Invalid diagnostic receipt.");
    // Serialize against this process's writers; only a matching byte version may be deleted.
    const operation=this.tail.then(async()=>{
      for(const file of batch.files){
        let text:string;try{text=await readFile(file.path,"utf8");}catch(error){if((error as {code?:string}).code==='ENOENT')continue;throw error;}
        if(digest(text)===file.hash)await unlink(file.path).catch(error=>{if(error.code!=='ENOENT')throw error;});
      }
      this.receipts.delete(receipt);
    });
    this.tail=operation.catch(()=>{});await operation;
  }
  /** Core-owned retention also covers requests whose tenant could never be authenticated. */
  async prune(now=Date.now()):Promise<void>{
    const operation=this.tail.then(async()=>{
    const folders=await readdir(this.directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    const files:{path:string;modified:number;bytes:number}[]=[];
    for(const folder of folders){
      if(!folder.isDirectory()||(!uuid.test(folder.name)&&folder.name!=="unassigned"))continue;
      for(const name of await readdir(join(this.directory,folder.name))){
        if(!/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.json(?:\.tmp)?$/i.test(name))continue;
        const path=join(this.directory,folder.name,name);const info=await stat(path).catch(()=>null);
        if(info)files.push({path,modified:info.mtimeMs,bytes:info.size});
      }
    }
    let total=files.reduce((sum,f)=>sum+f.bytes,0);
    for(const file of files.sort((a,b)=>a.modified-b.modified))if(now-file.modified>(this.options.maximumAgeMs??14*86400000)||total>(this.options.maximumDiskBytes??2*1024*1024*1024)){
      try{await unlink(file.path);total-=file.bytes;this.health(file.path.split('/').at(-2)!).expiredUnprocessed++;}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error;}
    }
    });
    this.tail=operation.catch(()=>{});await operation;
  }
}
let journal:DiagnosticJournal|undefined;
export function configuredDiagnosticJournal():DiagnosticJournal|undefined{
  const directory=process.env.OPENSHAPEFORGE_MCP_DIAGNOSTICS_DIRECTORY;
  if(!directory)return undefined;
  if(!journal){
    journal=new DiagnosticJournal(directory);
    const timer=setInterval(()=>{void journal!.prune().catch(()=>{});},60*1000);timer.unref();
  }
  return journal;
}
