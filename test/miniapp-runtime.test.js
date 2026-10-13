import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { MINI_APP_HTML } from '../src/miniapp.js';

test('Mini App inline browser script is valid JavaScript', () => {
  const scripts = [...MINI_APP_HTML.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]).filter(Boolean).sort((a,b) => b.length-a.length);
  assert.ok(scripts[0]?.includes('async function load()'));
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: 'miniapp-inline.js' }));
});

test('Mini App preserves domain and whitespace regex escapes', () => {
  assert.ok(MINI_APP_HTML.includes("replace(/^https?:\\/\\//i,''"));
  assert.ok(MINI_APP_HTML.includes("replace(/\\s+/g,''"));
});
