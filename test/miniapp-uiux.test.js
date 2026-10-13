import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { MINI_APP_HTML } from '../src/miniapp.js';
test('v1.6.1 UX markers render',()=>{
  for (const marker of ['healthStrip','Recent activity','domainOptions','filterBar','refreshBtn','busyBar','Try again']) assert.ok(MINI_APP_HTML.includes(marker),marker);
});
test('inline Mini App JavaScript parses',()=>{
  const scripts=[...MINI_APP_HTML.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(Boolean).sort((a,b)=>b.length-a.length);
  assert.doesNotThrow(()=>new vm.Script(scripts[0],{filename:'miniapp-inline.js'}));
});
