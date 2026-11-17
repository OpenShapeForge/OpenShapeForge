// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from '@openshapeforge/operations';
import { generatedEntityValues } from '../../modules/entity-value-registry.js';
import { pageDesignFromStored } from '@openshapeforge/documents/page';
import type { GeneratedCrudColumn, GeneratedCrudTable, GeneratedEntityRow } from './types.js';
/** Shared create/update boundary: a partial update is checked with its locked row. */
export function guardDocumentPageWrite(table: GeneratedCrudTable, values: ReadonlyMap<GeneratedCrudColumn, unknown>, current?: GeneratedEntityRow): void {
  const entity = table.source?.authoringEntityName;
  if (entity !== 'Block' && entity !== 'DocumentTheme') return;
  const row = {...current, ...Object.fromEntries([...values].map(([column, value]) => [column.name, value]))};
  if (entity === 'Block' && (row.region ?? 'body') === 'body' && row.layout_key != null) {
    throw operationFailure({code:'INVALID_INPUT', message:'A body block cannot name a page layout.'});
  }
  if (entity === 'Block' && (row.region ?? 'body') !== 'body') {
    const definition = generatedEntityValues.get('Block', 'values')?.definitions[String(row.definition_key)];
    if (definition?.references.some(reference => reference.targetEntity === 'TemplateVersion' && reference.parameterColumn)) {
      throw operationFailure({code:'INVALID_INPUT', message:'A template inclusion must be a body block; header and footer inclusions are not supported.'});
    }
  }
  if (entity === 'DocumentTheme') {
    try { pageDesignFromStored(row.page_design); }
    catch { throw operationFailure({code:'INVALID_INPUT', message:'Use a valid page design, or leave it empty.'}); }
  }
}
