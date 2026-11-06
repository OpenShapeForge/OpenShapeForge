// SPDX-License-Identifier: BUSL-1.1
import { createHash } from 'node:crypto';
export function canonicalGrantValue(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalGrantValue).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalGrantValue((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const pick = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map(key => [key,value[key]]));
/** Pin execution behaviour, not catalogue labels, provenance or timestamps.
 * Credentials live on Connection, never in this fingerprint. Authentication
 * endpoints and mapping remain pinned because changing them redirects secrets. */
export function connectionGrantFingerprint(input: {execution: unknown;service: Record<string,unknown>;binding: Record<string,unknown>;capability: Record<string,unknown>;adapter: Record<string,unknown>}): string {
  const value = {
    execution:input.execution,
    service:pick(input.service,['id','key','status','version','inputFields','outputFields','visibleToRoles','internalOnly']),
    binding:pick(input.binding,['serviceId','capabilityId','order','optional','when','inputMapping','outputMapping','forEach']),
    capability:pick(input.capability,['id','adapterId','kind','operation','requiredScopes','inputFields','outputFields','requestMapping','responseMapping','pagination','resource']),
    adapter:pick(input.adapter,['id','transport','baseUrlTemplate','baseUrlTemplates','auth','configurationFields','egressHosts']),
  };
  return createHash('sha256').update(canonicalGrantValue(value)).digest('hex');
}
