// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import schema from '../../config/schemas/core-entity.schema.json' with { type: 'json' };

test('authored record-panel actions, section ordering and presentation pass the closed YAML schema', () => {
  const validate = new Ajv2020.default({ strict: false }).compile({ $defs: schema.$defs, $ref: '#/$defs/webCollectionTable' });
  const table = parse(`
heading: {title: {en: Catalogue}}
views: {tree: {en: Grouped}, flat: {en: All}}
label: {en: Product}
columns:
  - {key: name, label: {en: Name}, values: [{path: displayName}]}
recordPanel:
  title: {en: Details}
  actions: [edit, openFull]
  summaryColumns: [name]
  sections:
    - title: {en: Options}
      relationship: parts
      orderBy: position
      presentation: options
      label: {path: role}
      values: [{path: amount}]
`);
  expect(validate(table)).toBe(true);
  table.recordPanel.actions = [];
  expect(validate(table)).toBe(true);
  table.recordPanel.sections[0].presentation = 'rows';
  expect(validate(table)).toBe(true);
  table.recordPanel.actions = ['delete'];
  expect(validate(table)).toBe(false);
  table.recordPanel.actions = [];
  table.recordPanel.sections[0].presentation = 'unknown';
  expect(validate(table)).toBe(false);
  table.recordPanel.sections[0].presentation = 'rows';
  table.recordPanel.sections[0].orderBy = '';
  expect(validate(table)).toBe(false);
});
