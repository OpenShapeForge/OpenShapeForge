// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createAuthoringValidator} from './schema-validation.js';
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

test('named record editing requires a layout and rejects the fields-only variant', () => {
  const raw=parse(readFileSync(join(import.meta.dir,'../../config/authoring/entities/core/block.yaml'),'utf8'));
  const validator=createAuthoringValidator();
  const check=(definition:unknown)=>()=>{raw.interfaces.web.views.named={panel:definition};validator.validate(raw,'block.yaml');};
  const layout={tabs:[{id:'details',label:{en:'Details',nl:'Details'},groups:[{id:'content',title:{en:'Content',nl:'Content'},fields:['values']}]}],context:{fields:['id']}};
  expect(check({kind:'record',actions:['update'],layout})).not.toThrow();
  expect(check({kind:'record',actions:['update'],fields:['values']})).toThrow();
  expect(check({kind:'record',fields:['values']})).not.toThrow();
});
