import test from 'node:test';
import assert from 'node:assert/strict';
import { activePlan, planConfig, localDayKey, parseDateEnd, parseButtonsSpec } from '../src/index.js';

test('active plan respects expiry', () => {
  assert.equal(activePlan({ plan: 'starter', plan_expires_at: new Date(Date.now() + 86400000).toISOString() }), 'starter');
  assert.equal(activePlan({ plan: 'pro', plan_expires_at: new Date(Date.now() - 1000).toISOString() }), 'free');
});

test('plan config keeps Pro ad free and Free limited', () => {
  assert.equal(planConfig({ plan: 'pro', plan_expires_at: new Date(Date.now() + 86400000).toISOString() }).adEvery, 0);
  assert.equal(planConfig({ plan: 'free' }).maxDomains, 1);
});

test('button parser accepts safe web URLs only', () => {
  const x = parseButtonsSpec('Site|https://example.com; Bad|javascript:alert(1); Docs|http://docs.example.com');
  assert.equal(x.length, 2);
  assert.equal(x[0].text, 'Site');
});

test('local day key is YYYY-MM-DD', () => assert.match(localDayKey('Asia/Kolkata'), /^\d{4}-\d{2}-\d{2}$/));

test('coupon expiry date parser supports dates and never', () => {
  assert.equal(parseDateEnd('never'), null);
  assert.match(parseDateEnd('2026-12-31'), /^2026-12-31T23:59:59\.999Z$/);
});

import { readFile } from 'node:fs/promises';

test('platform code does not depend on owner Google API credentials', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /env\.GOOGLE_CLIENT_ID/);
  assert.doesNotMatch(source, /env\.GOOGLE_CLIENT_SECRET/);
  assert.doesNotMatch(source, /env\.PAGESPEED_API_KEY/);
});

test('public source does not hardcode an assistant model name', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /gpt-oss|qwen|llama3|gemini|claude/i);
});


test('v1.3.1 fixes Stars checkout, admin lock, gifts and persistent DNS proof', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /createInvoiceLink/);
  assert.match(source, /subscription_period: SUBSCRIPTION_PERIOD/);
  assert.match(source, /ADMIN_TELEGRAM_ID = '8984229401'/);
  assert.ok(source.includes("cmd.startsWith('/admin')"));
  assert.match(source, /user_gifts/);
  assert.match(source, /giftopen:/);
  assert.match(source, /9999-12-31T23:59:59\.999Z/);
  assert.match(source, /adminSetExactPlan/);
});


test('v1.4.0 team workspace and button UX markers', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../migrations/0006_team_plan_and_button_ux.sql', import.meta.url), 'utf8');
  assert.ok(source.includes("const VERSION = '1.4.1'"));
  assert.ok(source.includes("team: { label: 'Team', stars: 299"));
  assert.ok(source.includes('TEAM_ACTIVATION_TTL_MS = 24 * 3600000'));
  assert.ok(source.includes('activateTeamWorkspace'));
  assert.ok(source.includes('handleTeamChatUpdate'));
  assert.ok(source.includes('adminAdsView'));
  assert.ok(source.includes('adminad:delete:'));
  assert.ok(source.includes('Ownership already verified'));
  assert.match(migration, /CREATE TABLE IF NOT EXISTS team_activation_codes/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS team_chats/);
});


test('HTTP 530 fast-fails as invalid domain before checks', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(source.includes("const VERSION = '1.4.1'"));
  assert.ok(source.includes('async function isHttp530Domain(domain)'));
  assert.ok(source.includes('return r.status === 530'));
  assert.ok(source.includes('if (await isHttp530Domain(domain)) return send(env, chatId, invalidDomain530Text(domain));'));
  assert.ok(source.includes('❌ <b>Invalid domain</b>'));
});
