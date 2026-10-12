import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDomain, parseRdap, daysUntil, validTimezone, detectDnsProvider, detectHostingProvider,
  analyzeSeoHtml, parseRobots, parseSitemap, parseCertSpotter, fallbackKeywords
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
