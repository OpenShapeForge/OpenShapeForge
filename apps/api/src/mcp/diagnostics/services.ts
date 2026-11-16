// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeMcpDiagnosticServices } from "@openshapeforge/plugin-runtime/diagnostics";
import { configuredDiagnosticJournal } from "./journal.js";
export function diagnosticServices<Session extends {tenantId:string|null;userId:string|null;roles:readonly string[]}>(acceptsSession:(session:Session)=>boolean):RuntimeMcpDiagnosticServices<Session>{
 const admit=(session:Session)=>{
  if(!acceptsSession(session)||!session.tenantId||!session.userId||!session.roles.includes('McpInsights.Manage'))throw Error('Diagnostic access requires a live authorized tenant session.');
  const journal=configuredDiagnosticJournal();if(!journal)throw Error('MCP diagnostics have not been configured on this host.');
  return {journal,tenant:session.tenantId};
 };
 return {
  async read(session,options){const {journal,tenant}=admit(session);return journal.read(tenant,options?.limit);},
  async acknowledge(session,receipt){const {journal,tenant}=admit(session);await journal.acknowledge(tenant,receipt);},
 };
}
