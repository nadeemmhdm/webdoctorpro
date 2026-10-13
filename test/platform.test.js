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
  assert.ok(source.includes("const VERSION = '1.6.1'"));
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
  assert.ok(source.includes("const VERSION = '1.6.1'"));
  assert.ok(source.includes('async function isHttp530Domain(domain)'));
  assert.ok(source.includes('return r.status === 530'));
  assert.ok(source.includes('if (await isHttp530Domain(domain)) return send(env, chatId, invalidDomain530Text(domain));'));
  assert.ok(source.includes('❌ <b>Invalid domain</b>'));
});


test('v1.5 monitoring health email and registration controls are wired', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const lib = await readFile(new URL('../src/lib.js', import.meta.url), 'utf8');
  assert.match(source, /const VERSION = '1\.6\.1'/);
  assert.match(source, /UPTIME_CONFIRM_FAILURES = 2/);
  assert.match(source, /monitorWebsiteChanges/);
  assert.match(source, /website_change_events/);
  assert.match(source, /WEB DOCTOR SCORE/);
  assert.match(source, /compareText/);
  assert.match(source, /emergencyDoctor/);
  assert.match(source, /smtp\.gmail\.com/);
  assert.match(source, /registration_waitlist/);
  assert.match(source, /registrations_open/);
  assert.match(source, /adminemail:/);
  assert.match(source, /adminreg:/);
  assert.match(lib, /WEB DOCTOR Health Score/);
});


test('v1.5.1 verified pending commands and global SMTP sender UX are wired', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(source.includes("const VERSION = '1.6.1'"));
  assert.ok(source.includes("['/verified','/pending','/pwnding'].includes(cmd)"));
  assert.ok(source.includes("command: 'verified'"));
  assert.ok(source.includes("command: 'pending'"));
  assert.ok(source.includes('filteredSitesView'));
  assert.ok(source.includes('Global Email Notification Sender'));
  assert.ok(source.includes('single WEB DOCTOR PRO admin Gmail SMTP account'));
});


test('v1.6 Telegram Mini App keeps bot engine parity and authenticated admin dashboard', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const mini = await readFile(new URL('../src/miniapp.js', import.meta.url), 'utf8');
  assert.ok(source.includes("const VERSION = '1.6.1'"));
  assert.ok(source.includes("import { MINI_APP_HTML } from './miniapp.js'"));
  assert.ok(source.includes('validateMiniAppInitData'));
  assert.ok(source.includes("request.headers.get('x-telegram-init-data')"));
  assert.ok(source.includes("url.pathname === '/app'"));
  assert.ok(source.includes("url.pathname === '/api/mini/bootstrap'"));
  assert.ok(source.includes("url.pathname === '/api/mini/action'"));
  assert.ok(source.includes("url.pathname === '/api/mini/admin/media'"));
  assert.ok(source.includes("setChatMenuButton"));
  assert.ok(source.includes("await handleCommand(env, msg, user)"));
  assert.match(mini, /telegram-web-app\.js/);
  assert.match(mini, /Admin dashboard/);
  assert.match(mini, /Website manager/);
  assert.match(mini, /Command console/);
  assert.match(source, /ad_create_text/);
  assert.match(mini, /Create broadcast draft/);
  assert.match(mini, /Create sponsored ad/);
  assert.match(mini, /broadcast_queue/);
  assert.match(mini, /ad_toggle/);
  assert.match(mini, /adminMedia/);
});
