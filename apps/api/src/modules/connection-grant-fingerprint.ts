// SPDX-License-Identifier: BUSL-1.1
/** Pin execution behaviour, not catalogue labels, provenance or timestamps.
 * Credentials live on Connection, never in this fingerprint. Authentication
 * endpoints and mapping remain pinned because changing them redirects secrets. */
import { createHash } from 'node:crypto';
import {stableSnapshotJson} from '../mcp/catalog-rows.js';
export const canonicalGrantValue=stableSnapshotJson;
const pick = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map(key => [key,value[key]]));
export function connectionGrantFingerprint(input: {execution: {parentRef:string;operationRef:string;providerRef:string};service: Record<string,unknown>;binding: Record<string,unknown>;capability: Record<string,unknown>;adapter: Record<string,unknown>}): string {
  const value = {
    execution:input.execution,
    service:pick(input.service,['id','key','status','version','inputFields','outputFields','visibleToRoles','internalOnly']),
    binding:pick(input.binding,[input.execution.parentRef,input.execution.operationRef,'order','optional','when','inputMapping','outputMapping','forEach']),
    capability:pick(input.capability,['id',input.execution.providerRef,'kind','operation','requiredScopes','inputFields','outputFields','requestMapping','responseMapping','pagination','resource']),
    adapter:pick(input.adapter,['id','transport','baseUrlTemplate','baseUrlTemplates','auth','configurationFields','egressHosts']),
  };
  return createHash('sha256').update(canonicalGrantValue(value)).digest('hex');
}
