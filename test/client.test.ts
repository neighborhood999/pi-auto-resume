import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeJwtPayload, errText, num, parseEpochOrIso, pick } from '../src/providers/client.ts';

test('pick reads property from object', () => {
  assert.equal(pick({ a: 1 }, 'a'), 1);
});

test('pick returns undefined for non-object', () => {
  assert.equal(pick(null, 'a'), undefined);
  assert.equal(pick(42, 'a'), undefined);
});

test('num coerces finite number', () => {
  assert.equal(num(42), 42);
  assert.equal(num('3.14'), 3.14);
});

test('num rejects non-finite', () => {
  assert.equal(num(NaN), null);
  assert.equal(num(Infinity), null);
  assert.equal(num(''), null);
  assert.equal(num(null), null);
});

test('errText extracts Error message', () => {
  assert.equal(errText(new Error('boom')), 'boom');
});

test('errText stringifies non-Error', () => {
  assert.equal(errText('oops'), 'oops');
  assert.equal(errText(42), '42');
});

test('decodeJwtPayload extracts claims', () => {
  const payload = { sub: 'user-1', exp: 9999999999 };
  const token = `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
  const result = decodeJwtPayload(token);
  assert.ok(result);
  assert.equal(result['sub'], 'user-1');
});

test('decodeJwtPayload returns null for invalid token', () => {
  assert.equal(decodeJwtPayload('no-dots'), null);
  assert.equal(decodeJwtPayload('a.!!!.b'), null);
});

test('parseEpochOrIso parses epoch seconds', () => {
  assert.equal(parseEpochOrIso('1700000000'), 1700000000 * 1000);
});

test('parseEpochOrIso parses epoch milliseconds', () => {
  assert.equal(parseEpochOrIso('1700000000000'), 1700000000000);
});

test('parseEpochOrIso parses ISO 8601', () => {
  const iso = '2024-01-01T00:00:00.000Z';
  assert.equal(parseEpochOrIso(iso), Date.parse(iso));
});

test('parseEpochOrIso returns null for garbage and non-positive epochs', () => {
  assert.equal(parseEpochOrIso('not-a-date'), null);
  assert.equal(parseEpochOrIso('0'), null);
  assert.equal(parseEpochOrIso('999999999999999999999999999'), null);
});
