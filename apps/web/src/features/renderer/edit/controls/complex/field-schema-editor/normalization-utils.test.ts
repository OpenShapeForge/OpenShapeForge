// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import { normalizeComputed } from './normalization-utils';

test('preserves temporal configuration and normalizes expression fields', () => {
  const temporal = { kind: 'temporalThreshold' as const, field: 'stage', thresholdDays: 'threshold' };
  expect(normalizeComputed(temporal)).toEqual(temporal);
  expect(normalizeComputed({ expression: ' {{name}} ', dependencies: [' name ', ''] })).toEqual({ expression: '{{name}}', dependencies: ['name'] });
});
