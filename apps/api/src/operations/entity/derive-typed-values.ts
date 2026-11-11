// SPDX-License-Identifier: BUSL-1.1
import { derivedSlugCandidate, maxDerivedIdentifierAttempts } from './derive-on-create.js';
import { generatedCrudError } from './catalog.js';
type Schema = Record<string, any>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Materialize authored create-time identities in typed objects. Collections
 * match existing members by their persisted identity, never by row position. */
export function deriveTypedValue(schema: Schema, value: unknown, previous?: unknown): unknown {
  if (Array.isArray(value) && schema.items) {
    const item = schema.items as Schema;
    const identities = Object.entries(item.properties ?? {}).filter(([, child]) => (child as Schema)['x-osf-derive-on-create']);
    if (identities.length > 1) throw generatedCrudError('A typed collection supports one create-time identity.', 'INVALID_DEFINITION');
    const identity = identities[0]?.[0];
    const old = Array.isArray(previous) ? previous : [];
    const occupied = new Set(old.filter(record).map(row => identity ? row[identity] : undefined));
    const seen = new Set<unknown>();
    return value.map(row => {
      if (!record(row) || !identity) return deriveTypedValue(item, row);
      const key = row[identity];
      const existing = key === undefined || key === '' ? undefined : old.find(candidate => record(candidate) && candidate[identity] === key);
      if (key !== undefined && key !== '' && !existing) throw generatedCrudError('New identifiers are derived from their name; omit the identifier.', 'BAD_USER_INPUT');
      const result = deriveObject(item, row, existing, occupied);
      if (seen.has(result[identity])) throw generatedCrudError('Duplicate typed collection identity.', 'BAD_USER_INPUT');
      seen.add(result[identity]); occupied.add(result[identity]);
      return result;
    });
  }
  return record(value) && schema.properties ? deriveObject(schema, value, previous) : value;
}
function deriveObject(schema: Schema, value: Record<string, unknown>, previous?: unknown, occupied = new Set<unknown>()): Record<string, unknown> {
  const result = { ...value };
  for (const [key, child] of Object.entries(schema.properties ?? {}) as [string, Schema][]) {
    const rule = child['x-osf-derive-on-create'];
    const old = record(previous) ? previous[key] : undefined;
    if (!rule) { if (Object.hasOwn(result, key)) result[key] = deriveTypedValue(child, result[key], old); continue; }
    if (rule.transform !== 'slug' || rule.onConflict !== 'suffix') throw generatedCrudError('Unsupported create-time derivation.', 'INVALID_DEFINITION');
    if (old !== undefined) {
      if (result[key] !== undefined && result[key] !== old) throw generatedCrudError('A derived identifier cannot be changed.', 'BAD_USER_INPUT');
      result[key] = old; continue;
    }
    if (result[key] !== undefined && result[key] !== '') throw generatedCrudError('A new derived identifier cannot be supplied.', 'BAD_USER_INPUT');
    let source = result[rule.from];
    // Identifier contracts may require a leading letter, including names such as 2027.
    if (typeof source === 'string' && /^\d/.test(derivedSlugCandidate(source, 1))) source = `item-${source}`;
    let allocated = false;
    for (let attempt = 1; attempt <= maxDerivedIdentifierAttempts(); attempt++) {
      const candidate = derivedSlugCandidate(source, attempt, child.maxLength);
      if (!occupied.has(candidate)) { result[key] = candidate; allocated = true; break; }
    }
    if (!allocated) throw generatedCrudError('Could not allocate a unique identifier.', 'BAD_USER_INPUT');
  }
  return result;
}
