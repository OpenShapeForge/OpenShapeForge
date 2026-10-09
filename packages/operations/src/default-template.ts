// SPDX-License-Identifier: BUSL-1.1
/** Bounded interpolation, never expressions or executable code. */
export function defaultTemplatePaths(template: string): string[] {
  if (!template || template.length > 2000) throw new Error('defaultTemplate must contain 1–2000 characters.');
  const paths: string[] = [];
  const remainder = template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)?)\s*\}\}/g, (_, path: string) => { paths.push(path); return ''; });
  if (/[{}]/.test(remainder)) throw new Error('defaultTemplate accepts only {{field}} or {{relationship.field}} references.');
  if (!paths.length) throw new Error('Use defaultValue for a literal default.');
  return [...new Set(paths)];
}
export function renderDefaultTemplate(template: string, values: ReadonlyMap<string, unknown>): string {
  defaultTemplatePaths(template);
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)?)\s*\}\}/g, (_, path: string) => {
    const value = values.get(path);
    if (value === undefined || value === null || !['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`Default source ${path} is unavailable.`);
    return String(value);
  });
}
