// SPDX-License-Identifier: BUSL-1.1
import {AsyncLocalStorage}from"node:async_hooks";
import {randomUUID}from"node:crypto";
import type {ServerResponse}from"node:http";
import type {FastifyReply,FastifyRequest}from"fastify";
import {capture,fingerprint,normalizeMetadata,object,type Json,type ObjectValue,type UsageEvent,type ContractSnapshot}from"@openshapeforge/plugin-runtime/diagnostics";
import type {TrustedSessionContext}from"../../auth/trusted-context.js";
import {configuredDiagnosticJournal,type DiagnosticJournal}from"./journal.js";

const observers=new AsyncLocalStorage<McpDiagnosticObserver>();
const instructions=new WeakMap<object,string>();
const serverClients=new WeakMap<object,UsageEvent['client']>();
const string=(value:unknown):string|null=>typeof value==='string'?value:null;
export function rememberDiagnosticServer(server:object,text:string):void{
 instructions.set(server,text);const observer=observers.getStore();
 if(observer){serverClients.set(server,{...observer.event.client});observer.contract(undefined,undefined,text);}
}
export function bindDiagnosticSession(session:TrustedSessionContext,server?:object):void{
 const observer=observers.getStore();if(!observer)return;
 observer.bind(session,server?instructions.get(server):undefined);
 const client=server?serverClients.get(server):undefined;
 if(client){observer.event.client={name:observer.event.client.name??client.name,version:observer.event.client.version??client.version,protocol:observer.event.client.protocol??client.protocol,capabilities:observer.event.client.capabilities??client.capabilities};}
}
export function observeDiagnosticContract(tool:unknown,operation?:unknown,server?:object):void{observers.getStore()?.contract(tool,operation,server?instructions.get(server):undefined);}
export function observeDiagnosticOperation(operation:unknown):void{observers.getStore()?.operation(operation);}
export function observeDiagnosticFailure(cause:unknown):void{observers.getStore()?.failure(cause);}
/** Retain extensible client context, while credential-bearing headers never enter the capture. */
export function diagnosticHeaders(headers:FastifyRequest['headers']):Record<string,unknown>{
 const result:Record<string,unknown>={};
 for(const [key,value]of Object.entries(headers)){
  if(/auth|cookie|token|secret|api[-_]?key|password|credential/i.test(key))continue;
  if(key==='x-codex-turn-metadata'&&typeof value==='string'){try{result[key]=JSON.parse(value);}catch{result[key]=value;}}
  else result[key]=value;
 }
 return result;
}

export class McpDiagnosticObserver{
 readonly event:UsageEvent;
 private snapshots:ContractSnapshot[]=[];
 private buffer='';private streamBytes=0;private contentType='';private status=0;private closed=false;
 private decoder=new TextDecoder();private wireTruncated=false;
 private contractParts:{tool:unknown;operation:unknown;instructions:string|null}={tool:null,operation:null,instructions:null};
 private rawArguments:unknown;
 private confidentialPaths=new Set<string>();
 private rootOperation:{id:string|null;component:string|null}|null=null;
 private nestedOperations:unknown[]=[];
 constructor(readonly journal:DiagnosticJournal,body:unknown,headers:FastifyRequest['headers'],method:string,readonly started=Date.now()){
  const envelope=object(body),params=object(envelope?.params),meta=object(params?._meta)??{};
  const safeHeaders=diagnosticHeaders(headers);
  const captured=capture({...safeHeaders,...meta,transportHeaders:safeHeaders,requestEnvelope:{...envelope,params:{...params,arguments:undefined}}});
  const metadata=object(captured.value) as ObjectValue;
  const argument=capture(params?.arguments??params??body);
  this.rawArguments=params?.arguments??params??body;
  const client=object(params?.clientInfo)??object(meta['io.modelcontextprotocol/clientInfo']);
  this.event={id:randomUUID(),tenantId:null,actorId:null,environment:process.env.OPENSHAPEFORGE_DEPLOYMENT_ENVIRONMENT??process.env.NODE_ENV??'development',receivedAt:new Date(started).toISOString(),completedAt:null,method:string(envelope?.method)??method,toolName:string(params?.name),operationId:null,component:null,external:true,parentId:null,systemOrigin:false,client:{name:string(client?.name),version:string(client?.version),protocol:string(params?.protocolVersion)??string(headers['mcp-protocol-version'])??string(meta['io.modelcontextprotocol/protocolVersion']),capabilities:capture(params?.capabilities??meta['io.modelcontextprotocol/clientCapabilities']??null).value},metadata,correlation:normalizeMetadata(metadata,string(headers['mcp-session-id'])??undefined),arguments:argument.value,result:null,outcome:'unknown',error:null,httpStatus:null,isError:false,durationMs:null,responseBytes:0,delivery:'prepared',contractHash:null,taskId:string(params?.taskId),redactions:[...captured.redactions.map(p=>`/metadata${p}`),...argument.redactions.map(p=>`/arguments${p}`)],truncated:[...captured.truncated.map(p=>`/metadata${p}`),...argument.truncated.map(p=>`/arguments${p}`)]};
 }
 bind(session:TrustedSessionContext,text?:string):void{
  this.event.tenantId=session.tenantId??null;this.event.actorId=session.userId??null;
  this.event.systemOrigin=session.roles?.includes('McpInsights.Manage')===true&&this.event.operationId?.startsWith('mcp-insights.')===true;
  if(text!==undefined)this.contract(undefined,undefined,text);
 }
 contract(tool:unknown,operation?:unknown,text?:string):void{
  if(tool!==undefined&&tool!==null)this.contractParts.tool=tool;
  if(operation!==undefined)this.contractParts.operation=operation;
  if(text!==undefined)this.contractParts.instructions=text;
  const definition=object(operation);
  const input=object(definition?.input);
  const interaction=object(definition?.interaction);
  const schema=object(input?.schema)??object(object(tool)?.inputSchema);
  const paths:string[]=[];
  const walk=(value:unknown,path:string,depth:number)=>{
   const node=object(value);if(!node||depth>64)return;
   if(object(node['x-osf-classification'])?.sensitivity==='confidential'||node.writeOnly===true){paths.push(path);return;}
   for(const [key,child]of Object.entries(object(node.properties)??{}))walk(child,`${path}/${key.replaceAll('~','~0').replaceAll('/','~1')}`,depth+1);
   for(const branch of ['allOf','anyOf','oneOf'])if(Array.isArray(node[branch]))for(const child of node[branch])walk(child,path,depth+1);
  };
  walk(schema,'',0);
  if(interaction?.secureInput)paths.push('');
  for(const path of paths)this.confidentialPaths.add(path);
  if(this.confidentialPaths.size){const secured=capture(this.rawArguments,{confidentialPaths:[...this.confidentialPaths]});this.event.arguments=secured.value;this.event.redactions.push(...secured.redactions.map(p=>`/arguments${p}`));}
  const content=capture(this.contractParts,{schemaDocument:true});
  const snapshot:ContractSnapshot={tenantId:this.event.tenantId,hash:fingerprint(content.value),capturedAt:new Date().toISOString(),content:content.value};
  this.snapshots.push(snapshot);this.event.contractHash=snapshot.hash;
  if(typeof definition?.id==='string')this.event.operationId=definition.id;
  if(typeof definition?.owner==='string')this.event.component=definition.owner;
  this.event.redactions.push(...content.redactions.map(p=>`/contract${p}`));this.event.truncated.push(...content.truncated.map(p=>`/contract${p}`));
 }
 operation(value:unknown):void{
  const definition=object(value);
  if(!definition)return;
  this.contract(null,value);
  this.nestedOperations.push(value);
  this.contractParts.operation={root:this.nestedOperations[0],nested:this.nestedOperations.slice(1)};
  this.contract(null,undefined);
  if(typeof definition.id==='string')this.event.operationId=definition.id;
  const implementation=object(definition.implementation);
  this.event.component=string(implementation?.plugin)??string(definition.owner)??this.event.component;
  if(this.rootOperation){this.event.operationId=this.rootOperation.id;this.event.component=this.rootOperation.component;}
  else this.rootOperation={id:this.event.operationId,component:this.event.component};
  if(this.event.operationId?.startsWith('mcp-insights.'))this.event.systemOrigin=true;
 }
 private persist():void{this.journal.record(this.event,this.snapshots);}
 failure(cause:unknown):void{
  const plain=(value:unknown,depth:number):unknown=>value instanceof Error?{...value,name:value.name,message:value.message,stack:value.stack,cause:depth<6?plain(value.cause,depth+1):'[cause depth limit]'}:value;
  const captured=capture(plain(cause,0));
  const failures=Array.isArray(this.event.metadata.serverFailures)?this.event.metadata.serverFailures:[];
  if(failures.length<20)this.event.metadata.serverFailures=[...failures,captured.value];
  else this.event.truncated.push('/metadata/serverFailures');
  this.event.redactions.push(...captured.redactions.map(p=>`/metadata/serverFailures${p}`));
  this.event.truncated.push(...captured.truncated.map(p=>`/metadata/serverFailures${p}`));
 }
 headers(status:number,type:string):void{this.status=status;this.contentType=type;this.event.httpStatus=status;}
 chunk(chunk:Uint8Array|string):void{
  if(this.closed)return;
  const bytes=typeof chunk==='string'?Buffer.byteLength(chunk):chunk.byteLength;this.event.responseBytes+=bytes;
  if(this.wireTruncated)return;
  this.streamBytes+=bytes;
  if(this.streamBytes>8*1024*1024){this.wireTruncated=true;this.event.truncated.push('/wireResponse');this.buffer='';return;}
  this.buffer+=typeof chunk==='string'?chunk:this.decoder.decode(chunk,{stream:true});
  if(this.contentType.includes('text/event-stream')){
   let end:number;
   while((end=this.buffer.search(/\r?\n\r?\n/))>=0){
    const match=this.buffer.slice(end).match(/^\r?\n\r?\n/)![0];const frame=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+match.length);
    const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(data)this.json(data);
   }
  }
 }
 private json(text:string):void{
  let raw:unknown;try{raw=JSON.parse(text);}catch{return;}
  const envelope=object(raw),result=object(envelope?.result),error=object(envelope?.error);
  if(this.status>=400&&envelope?.id===undefined){this.result(raw);return;}
  if(!result&&!error){if(this.status>=400)this.result(raw);return;}
  // Notifications and server-originated exchanges are context, not the outcome of this call.
  if(envelope?.id===undefined)return;
  this.result(result??{error});this.event.delivery='prepared';this.persist();
 }
 private result(raw:unknown):void{
  const captured=capture(raw);this.event.result=captured.value;
  this.event.redactions.push(...captured.redactions.map(p=>`/result${p}`));this.event.truncated.push(...captured.truncated.map(p=>`/result${p}`));
  const result=object(raw),terminal=object(result?.result),payload=result?.status==='completed'&&terminal?terminal:result;
  const structured=object(payload?.structuredContent),error=object(payload?.error)??object(structured?.error);
  this.event.isError=payload?.isError===true||!!error||result?.status==='failed';
  const taskId=string(result?.taskId)??string(object(result?.task)?.taskId);if(taskId)this.event.taskId=taskId;
  const code=string(error?.code)??(typeof error?.code==='number'?String(error.code):null);
  if(this.event.isError||this.status>=400){
   const details=object(error?.details);const violations=Array.isArray(details?.errors)?details.errors:Array.isArray(error?.details)?error.details:[];
   const message=capture(error?.message??'Tool returned an error; see the retained result.');
   this.event.redactions.push(...message.redactions.map(p=>`/error/message${p}`));
   this.event.error={code:code??(this.status>=400?`HTTP_${this.status}`:'TOOL_ERROR'),message:typeof message.value==='string'?message.value:'[REDACTED]',paths:violations.flatMap(item=>{const value=object(item);const path=string(value?.instancePath)??string(value?.path);return path?[path]:[];})};
   this.event.outcome=this.status===401||this.status===403||['FORBIDDEN','UNAUTHORIZED'].includes(code??'')?'authorization_refusal':['-32602','VALIDATION','VALIDATION_ERROR','BAD_USER_INPUT','INVALID_ARGUMENTS'].includes(code??'')||this.status===422?'input_error':code?.startsWith('-326')?'protocol_error':['CONFIRMATION_REQUIRED','VERSION_CONFLICT','LEASE_REQUIRED','PRECONDITION_FAILED'].includes(code??'')?'business_refusal':'runtime_error';
  }else this.event.outcome=result?.status==='cancelled'?'cancelled':result?.status==='working'||result?.status==='input_required'?'unknown':'success';
  this.event.completedAt=new Date().toISOString();this.event.durationMs=Date.now()-this.started;
 }
 finish(interrupted=false):void{
  if(this.closed)return;this.closed=true;
  if(!this.contentType.includes('text/event-stream')&&this.buffer)this.json(this.buffer);
  if(this.event.completedAt===null){this.event.completedAt=new Date().toISOString();this.event.durationMs=Date.now()-this.started;this.event.outcome=interrupted?'cancelled':this.wireTruncated?'unknown':[401,403].includes(this.status)?'authorization_refusal':this.status>=500?'runtime_error':this.status>=400?'protocol_error':this.status>=200&&this.status<300?'success':'unknown';}
  this.event.delivery=interrupted?'interrupted':'sent';this.persist();
 }
}

/** Observes bytes already being written; never consumes or tees a response stream. */
export function observeMcpHttp<T>(request:FastifyRequest,reply:FastifyReply,work:()=>Promise<T>,journal=configuredDiagnosticJournal()):Promise<T>{
 if(!journal)return work();
 const observer=new McpDiagnosticObserver(journal,request.body,request.headers,request.method);
 const response=reply.raw as ServerResponse;
 const originalWrite=response.write,originalEnd=response.end;
 const note=(chunk:unknown)=>{if(typeof chunk==='string'||chunk instanceof Uint8Array){observer.headers(response.statusCode,String(response.getHeader('content-type')??''));observer.chunk(chunk);}};
 // Preserve overloads, callbacks, return values and backpressure of Node's exact methods.
 response.write=function(this:ServerResponse,...args:Parameters<ServerResponse['write']>){note(args[0]);return Reflect.apply(originalWrite,this,args);} as ServerResponse['write'];
 response.end=function(this:ServerResponse,...args:Parameters<ServerResponse['end']>){note(args[0]);return Reflect.apply(originalEnd,this,args);} as ServerResponse['end'];
 response.once('finish',()=>{observer.headers(response.statusCode,String(response.getHeader('content-type')??''));observer.finish(false);});
 response.once('close',()=>observer.finish(!response.writableFinished));
 return observers.run(observer,async()=>{try{return await work();}catch(cause){observer.failure(cause);throw cause;}});
}
