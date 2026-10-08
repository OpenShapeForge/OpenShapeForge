// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {EventEmitter} from 'node:events';
import type {IncomingMessage} from 'node:http';
import {randomUUID} from 'node:crypto';
import {Server} from '@modelcontextprotocol/server';
import {FastifyStreamableHTTPServerTransport} from '../legacy-http.js';

class ResponseProbe extends EventEmitter {
  status=0; destroyed=false; chunks:string[]=[];
  ready=Promise.withResolvers<number>();
  writeHead(status:number){this.status=status;this.ready.resolve(status);return this;}
  write(chunk:Uint8Array){this.chunks.push(new TextDecoder().decode(chunk));return true;}
  end(){this.emit('close');return this;}
  disconnect(){this.destroyed=true;this.emit('close');}
}

test('silent MCP disconnect releases only its accepted stream and permits repeated reconnects',async()=>{
  const transport=new FastifyStreamableHTTPServerTransport({sessionIdGenerator:randomUUID,enableJsonResponse:true});
  const server=new Server({name:'stream-disconnect-test',version:'1'},{capabilities:{}});
  await server.connect(transport);
  const init=await transport.handleRequest(new Request('http://localhost/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}})}));
  expect(init.status).toBe(200);await init.json();
  const request={method:'GET',url:'/mcp',headers:{accept:'text/event-stream','mcp-session-id':transport.sessionId,'mcp-protocol-version':'2025-03-26'},async *[Symbol.asyncIterator](){}} as unknown as IncomingMessage;
  const pending:Promise<void>[]=[];
  try {
    for(let cycle=0;cycle<3;cycle++){
      const active=new ResponseProbe();
      const handled=transport.handleNodeRequest(request,active as never);pending.push(handled);
      expect(await active.ready.promise).toBe(200);
      const duplicate=new ResponseProbe();
      await transport.handleNodeRequest(request,duplicate as never);
      expect(duplicate.status).toBe(409);
      // Ending a refused GET must not close the accepted stream.
      await transport.send({jsonrpc:'2.0',method:'notifications/message',params:{level:'info',data:`cycle ${cycle}`}});
      await Bun.sleep(0);
      expect(active.chunks.join('')).toContain(`cycle ${cycle}`);
      active.disconnect();
      expect(await Promise.race([handled.then(()=>true),Bun.sleep(250).then(()=>false)])).toBe(true);
    }
  } finally {await transport.close();await Promise.allSettled(pending);await server.close();}
});
