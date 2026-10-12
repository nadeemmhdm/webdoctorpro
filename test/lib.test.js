import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDomain, parseRdap, daysUntil, validTimezone, detectDnsProvider, detectHostingProvider,
  analyzeSeoHtml, analyzeGeoAeo, parseRobots, parseSitemap, parseCertSpotter, fallbackKeywords,
  normalizeTxtRecord, parsePageSpeed, scheduleIntervalMs, buildReportPdf
} from '../src/lib.js';

test('normalizeDomain strips URL/path', () => assert.equal(normalizeDomain('https://Example.COM/path?q=1'), 'example.com'));
test('normalizeDomain rejects invalid input', () => assert.throws(() => normalizeDomain('not-a-domain')));
test('parseRdap extracts expiration and registrar', () => {
  const x = parseRdap({ events:[{eventAction:'expiration',eventDate:'2030-01-01T00:00:00Z'}], entities:[{roles:['registrar'],vcardArray:['vcard',[['fn',{},'text','Example Registrar']]]}] });
  assert.equal(x.expiresAt,'2030-01-01T00:00:00Z'); assert.equal(x.registrar,'Example Registrar');
});
test('daysUntil rounds upward', () => assert.equal(daysUntil('2026-01-02T12:00:00Z', Date.parse('2026-01-01T13:00:00Z')),1));
test('timezone validation', () => { assert.equal(validTimezone('Asia/Kolkata'),true); assert.equal(validTimezone('Mars/Base'),false); });
test('detect DNS providers', () => assert.equal(detectDnsProvider(['lara.ns.cloudflare.com','rick.ns.cloudflare.com']),'Cloudflare'));
test('detect hosting by headers', () => assert.equal(detectHostingProvider({headers:{'cf-ray':'abc'}}),'Cloudflare'));
test('SEO analyzer scores complete page', () => {
  const html = `<!doctype html><html lang="en"><head><title>A useful example website title for testing</title><meta name="description" content="This is a useful and sufficiently detailed description for a test website page that explains the content clearly to search engines and users."><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://example.com"><meta property="og:title" content="x"><meta property="og:description" content="y"><script type="application/ld+json">{}</script></head><body><h1>Example heading</h1><a href="/about">About</a><img src="x" alt="Example"></body></html>`;
  const x = analyzeSeoHtml(html,'https://example.com/'); assert.ok(x.score >= 90); assert.equal(x.h1Count,1); assert.equal(x.internalLinkCount,1);
});
test('SEO analyzer finds major issues', () => { const x=analyzeSeoHtml('<html><body><img src="x"></body></html>','http://example.com'); assert.ok(x.score < 60); assert.ok(x.issues.length >= 4); });
test('robots parser finds block and sitemap', () => { const x=parseRobots('User-agent: *\nDisallow: /\nSitemap: https://example.com/sitemap.xml',200); assert.equal(x.blocksAll,true); assert.equal(x.sitemapUrls.length,1); });
test('sitemap parser counts URLs', () => { const x=parseSitemap('<urlset><url></url><url></url></urlset>',200); assert.equal(x.urlCount,2); });
test('cert parser chooses latest matching certificate', () => { const x=parseCertSpotter([{dns_names:['example.com'],not_after:'2027-01-01T00:00:00Z',issuer:{friendly_name:'CA'}},{dns_names:['example.com'],not_after:'2028-01-01T00:00:00Z'}],'example.com'); assert.equal(x.expiresAt,'2028-01-01T00:00:00Z'); });
test('fallback keywords returns deterministic words', () => { const x=fallbackKeywords({title:'Kerala Web Development Agency',description:'Professional website development and SEO services'},'example.com'); assert.ok(x.includes('development')); });

test('TXT normalization joins quoted segments', () => assert.equal(normalizeTxtRecord('"webdoctorpro-" "verification=abc"'), 'webdoctorpro-verification=abc'));
test('GEO/AEO analyzer rewards structured answer signals', () => {
  const html = `<html lang="en"><head><link rel="canonical" href="https://example.com"><script type="application/ld+json">{"@type":"Organization"}</script></head><body><h1>Service</h1><h2>What is this?</h2><p>This is a direct answer paragraph with enough detail to explain the topic clearly for users and answer systems while remaining concise and factual for testing purposes.</p><p>Another paragraph gives additional useful context for users and search systems while keeping the content readable and organized for this unit test.</p><a href="https://developers.google.com">Source</a><a href="https://www.iana.org">Reference</a><p>About us</p><p>Contact us</p><time datetime="2026-10-12"></time></body></html>`;
  const seo = analyzeSeoHtml(html,'https://example.com'); const x=analyzeGeoAeo(html,seo,{llmsTxt:true}); assert.ok(x.geoScore >= 60); assert.ok(x.aeoScore >= 50);
});
test('PageSpeed parser extracts Lighthouse scores', () => {
  const x=parsePageSpeed({lighthouseResult:{categories:{performance:{score:.82},seo:{score:.91},accessibility:{score:.88},'best-practices':{score:.75}},audits:{'largest-contentful-paint':{numericValue:2345.6},'cumulative-layout-shift':{numericValue:.1234},'total-blocking-time':{numericValue:123}}}});
  assert.equal(x.performance,82); assert.equal(x.seo,91); assert.equal(x.lcpMs,2346); assert.equal(x.cls,.123);
});
test('schedule intervals map supported frequencies', () => { assert.equal(scheduleIntervalMs('daily'),86400000); assert.equal(scheduleIntervalMs('weekly'),604800000); assert.equal(scheduleIntervalMs('off'),null); });
test('PDF builder emits a valid signed PDF header and metadata', () => {
  const x=buildReportPdf({domain:'example.com',version:'1.2.0',verified:true,generatedAt:'2026-10-12T12:00:00Z',generatedLocal:'12 Oct 2026 17:30 IST',siteStatus:'Reachable',seo:{score:90,issues:[],suggestions:[]},geoAeo:{geoScore:80,aeoScore:75,schemaTypes:[],geoSuggestions:[],aeoSuggestions:[]},robots:{exists:true,status:200},sitemap:{exists:true,type:'urlset',urlCount:3},links:{checked:2,broken:[]},recommendations:['Keep content useful'],keywords:['example keyword']});
  const text=new TextDecoder().decode(x.bytes); assert.ok(text.startsWith('%PDF-1.4')); assert.ok(text.includes('WEB DOCTOR PRO - Developer Nadeem')); assert.ok(text.includes('Report Signature'));
});
