// SPDX-License-Identifier: BUSL-1.1
/** Explicit opt-in compiler diagnostic. Never imported by the normal compiler. */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument, isMap, isSeq, LineCounter } from 'yaml';
import { resolveAuthoringLayers, arrayMergeKey, mergeKeyIdentity, type AuthoringConfig } from './layers.js';

export type InspectionSource = { path: string; package?: string; version?: string; hash: string; text: string; nodes: Record<string, { start: number; end: number; line: number }> };
export type InspectionDocument = { entity?: string; extends?: string; kind: string; sources: InspectionSource[]; changes: { path: string[]; source: number; action: 'set' | 'delete' }[] };
export type AuthoringInspection = { version: 1; documents: Record<string, InspectionDocument> };
export const inspectionPath = (parts: string[]) => JSON.stringify(parts);

export function collectAuthoringInspection(repoRoot: string, config?: AuthoringConfig, sourceRoots: { prepared: string; original: string }[] = []): AuthoringInspection {
  const result: AuthoringInspection = { version: 1, documents: {} };
  resolveAuthoringLayers(repoRoot, config, { document(target, sourcePath, patch) {
    // Never include deployment configuration, authorization, seeds or secrets.
    if (!(target.startsWith('entities/') || target === 'catalogs/osf-types.yaml' || /^contexts\/[^/]+\/osf-types.yaml$/.test(target) || target.startsWith('operations/')) || !target.endsWith('.yaml')) return;
    const text = readFileSync(sourcePath, 'utf8');
    for (const alias of sourceRoots) {
      const suffix = relative(alias.prepared, sourcePath);
      if (suffix.startsWith('..')) continue;
      const original = join(alias.original, suffix);
      if (existsSync(original) && readFileSync(original, 'utf8') === text) { sourcePath = original; break; }
    }
    const lines = new LineCounter();
    const ast = parseDocument(text, { lineCounter: lines });
    if (ast.errors.length) throw ast.errors[0];
    const value = ast.toJS();
    const doc = result.documents[target] ??= { kind: String(value.kind ?? 'catalog'), ...(value.entity ? { entity: value.entity } : {}), ...(value.extends ? { extends: value.extends } : {}), sources: [], changes: [] };
    const nodes: InspectionSource['nodes'] = {};
    function visit(node: any, path: string[]) {
      if (!node) return;
      if (node.range) nodes[inspectionPath(path)] = { start: node.range[0], end: node.range[1], line: lines.linePos(node.range[0]).line };
      if (isMap(node)) for (const pair of node.items) visit(pair.value, [...path, String(pair.key)]);
      if (isSeq(node)) {
        const values = node.toJSON(); const key = arrayMergeKey(values);
        node.items.forEach((item, i) => visit(item, [...path, key ? `${key}=${mergeKeyIdentity(values[i], key)}` : String(i)]));
      }
    }
    visit(ast.contents, []);
    let owner = dirname(sourcePath), identity: {package?: string; version?: string} = {}, path = relative(repoRoot, sourcePath);
    while (owner !== dirname(owner)) {
      const file = join(owner, 'package.json');
      if (existsSync(file)) { const pkg = JSON.parse(readFileSync(file, 'utf8')); identity = { package: pkg.name, version: pkg.version }; path = relative(owner, sourcePath); break; }
      owner = dirname(owner);
    }
    // Prepared host catalogues are honestly identified as host inputs, never
    // attributed to the package they may have been copied/modified from.
    const source = doc.sources.length;
    doc.sources.push({ path, ...identity, hash: createHash('sha256').update(text).digest('hex'), text, nodes });
    if (!patch) doc.changes.push({ path: [], source, action: 'set' });
    return (path, action) => doc.changes.push({ path, source, action });
  }});
  return result;
}
