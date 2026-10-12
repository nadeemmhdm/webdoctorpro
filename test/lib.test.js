import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomain, parseRdap, daysUntil, validTimezone } from '../src/lib.js';

test('normalizeDomain strips URL/path', () => assert.equal(normalizeDomain('https://Example.COM/path'), 'example.com'));
test('normalizeDomain rejects invalid input', () => assert.throws(() => normalizeDomain('not-a-domain')));
test('parseRdap extracts expiration and registrar', () => {
  const x = parseRdap({ events: [{ eventAction: 'expiration', eventDate: '2030-01-01T00:00:00Z' }], entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar']]] }] });
  assert.equal(x.expiresAt, '2030-01-01T00:00:00Z');
  assert.equal(x.registrar, 'Example Registrar');
});
test('daysUntil rounds upward', () => assert.equal(daysUntil('2026-01-02T12:00:00Z', Date.parse('2026-01-01T13:00:00Z')), 1));
test('timezone validation', () => { assert.equal(validTimezone('Asia/Kolkata'), true); assert.equal(validTimezone('Mars/Base'), false); });
