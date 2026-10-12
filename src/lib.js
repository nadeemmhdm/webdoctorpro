export function normalizeDomain(input) {
  const raw = String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split('?')[0].split('#')[0].replace(/\.$/, '');
  if (!raw || raw.length > 253 || raw.includes(' ') || !raw.includes('.')) throw new Error('Invalid domain');
  const hostname = new URL(`http://${raw}`).hostname;
  if (!/^[a-z0-9.-]+$/.test(hostname) || hostname.includes('..') || hostname.startsWith('.') || hostname.endsWith('.')) throw new Error('Invalid domain');
  const labels = hostname.split('.');
  if (labels.some((x) => !x || x.length > 63 || x.startsWith('-') || x.endsWith('-'))) throw new Error('Invalid domain');
  return hostname;
}

export function parseRdap(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  const findEvent = (...names) => events.find((e) => names.includes(String(e?.eventAction || '').toLowerCase()))?.eventDate || null;
  const entities = Array.isArray(data?.entities) ? data.entities : [];
  let registrar = null;
  for (const entity of entities) {
    if (!Array.isArray(entity?.roles) || !entity.roles.includes('registrar')) continue;
    const rows = entity?.vcardArray?.[1];
    if (Array.isArray(rows)) registrar = rows.find((r) => Array.isArray(r) && r[0] === 'fn')?.[3] || entity.handle || null;
    else registrar = entity.handle || null;
    if (registrar) break;
  }
  return {
    expiresAt: findEvent('expiration', 'expiry', 'registrar expiration'),
    registeredAt: findEvent('registration', 'registered'),
    lastChangedAt: findEvent('last changed', 'last update of rdap database'),
    registrar,
    status: Array.isArray(data?.status) ? data.status.join(', ') : 'unknown'
  };
}

export function daysUntil(iso, now = Date.now()) {
  if (!iso) return null;
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return null;
  return Math.ceil((value - now) / 86400000);
}

export function formatInTimezone(iso, timezone) {
  if (!iso) return 'Not available';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'UTC',
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    timeZoneName: 'short'
  }).format(new Date(iso));
}

export function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(); return true; } catch { return false; }
}

export function detectDnsProvider(nsRecords = []) {
  const value = nsRecords.join(' ').toLowerCase();
  const rules = [
    ['cloudflare', 'Cloudflare'], ['awsdns', 'Amazon Route 53'], ['azure-dns', 'Microsoft Azure DNS'],
    ['googledomains', 'Google Domains / Cloud DNS'], ['domaincontrol', 'GoDaddy DNS'], ['registrar-servers', 'Namecheap DNS'],
    ['dns-parking', 'Hostinger DNS'], ['nsone', 'NS1'], ['digitalocean', 'DigitalOcean DNS'], ['linode', 'Akamai / Linode DNS'],
    ['vercel-dns', 'Vercel DNS'], ['netlify', 'Netlify DNS']
  ];
  return rules.find(([needle]) => value.includes(needle))?.[1] || (nsRecords.length ? 'Custom / other DNS provider' : 'Unknown');
}

export function detectHostingProvider({ headers = {}, cnames = [] } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v).toLowerCase()]));
  const cname = cnames.join(' ').toLowerCase();
  if (h['cf-ray'] || h.server?.includes('cloudflare') || cname.includes('workers.dev') || cname.includes('pages.dev')) return 'Cloudflare';
  if (h['x-vercel-id'] || cname.includes('vercel.app') || cname.includes('vercel-dns')) return 'Vercel';
  if (h['x-nf-request-id'] || cname.includes('netlify.app') || cname.includes('netlify.com')) return 'Netlify';
  if (h.server?.includes('github.com') || cname.includes('github.io')) return 'GitHub Pages';
  if (h['x-render-origin-server'] || cname.includes('onrender.com')) return 'Render';
  if (h['fly-request-id'] || cname.includes('fly.dev')) return 'Fly.io';
  if (cname.includes('herokuapp.com')) return 'Heroku';
  if (cname.includes('amazonaws.com') || h.via?.includes('cloudfront') || h['x-amz-cf-id']) return 'Amazon Web Services';
  if (cname.includes('azurewebsites.net')) return 'Microsoft Azure';
  if (cname.includes('googlehosted.com') || cname.includes('run.app')) return 'Google Cloud';
  if (h.server?.includes('nginx')) return 'Nginx origin (provider not identifiable)';
  if (h.server?.includes('apache')) return 'Apache origin (provider not identifiable)';
  return 'Unknown / hidden';
}

function matchOne(html, re) { return re.exec(html)?.[1]?.trim() || ''; }
function count(html, re) { return (html.match(re) || []).length; }

export function extractLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(m[1], baseUrl);
      if (!['http:', 'https:'].includes(u.protocol)) continue;
      u.hash = '';
      const s = u.toString();
      if (!seen.has(s)) { seen.add(s); out.push(s); }
    } catch { /* ignore malformed URLs */ }
  }
  return out;
}

export function analyzeSeoHtml(html, pageUrl) {
  const title = matchOne(html, /<title[^>]*>([\s\S]*?)<\/title>/i).replace(/<[^>]+>/g, '').trim();
  const description = matchOne(html, /<meta\b(?=[^>]*\bname\s*=\s*["']description["'])[^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*>/i)
    || matchOne(html, /<meta\b(?=[^>]*\bcontent\s*=\s*["']([^"']*)["'])[^>]*\bname\s*=\s*["']description["'][^>]*>/i);
  const canonical = matchOne(html, /<link\b(?=[^>]*\brel\s*=\s*["'][^"']*canonical[^"']*["'])[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i);
  const lang = matchOne(html, /<html\b[^>]*\blang\s*=\s*["']([^"']+)["'][^>]*>/i);
  const viewport = /<meta\b[^>]*\bname\s*=\s*["']viewport["'][^>]*>/i.test(html);
  const ogTitle = /<meta\b[^>]*\bproperty\s*=\s*["']og:title["'][^>]*>/i.test(html);
  const ogDescription = /<meta\b[^>]*\bproperty\s*=\s*["']og:description["'][^>]*>/i.test(html);
  const noindex = /<meta\b[^>]*\bname\s*=\s*["']robots["'][^>]*\bcontent\s*=\s*["'][^"']*noindex/i.test(html);
  const h1Count = count(html, /<h1\b[^>]*>/gi);
  const h2Count = count(html, /<h2\b[^>]*>/gi);
  const imageCount = count(html, /<img\b[^>]*>/gi);
  const imageAltCount = count(html, /<img\b[^>]*\balt\s*=\s*["'][^"']*["'][^>]*>/gi);
  const jsonLd = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>/i.test(html);
  const links = extractLinks(html, pageUrl);
  const host = new URL(pageUrl).hostname;
  const internalLinks = links.filter((x) => new URL(x).hostname === host);
  const externalLinks = links.filter((x) => new URL(x).hostname !== host);

  let score = 100;
  const issues = [];
  const suggestions = [];
  const add = (severity, issue, suggestion, penalty) => { issues.push({ severity, issue }); suggestions.push(suggestion); score -= penalty; };
  if (!title) add('high', 'Missing page title', 'Add a unique <title> tag.', 15);
  else if (title.length < 30 || title.length > 60) add('medium', `Title length is ${title.length} characters`, 'Keep the title roughly 30–60 characters.', 5);
  if (!description) add('high', 'Missing meta description', 'Add a descriptive meta description.', 15);
  else if (description.length < 70 || description.length > 160) add('medium', `Meta description length is ${description.length} characters`, 'Keep the meta description roughly 70–160 characters.', 5);
  if (h1Count === 0) add('high', 'No H1 heading found', 'Add one clear H1 describing the page topic.', 10);
  else if (h1Count > 1) add('medium', `${h1Count} H1 headings found`, 'Prefer one primary H1 per page.', 5);
  if (!canonical) add('medium', 'Canonical URL is missing', 'Add a canonical link tag.', 5);
  if (!lang) add('low', 'HTML language is missing', 'Set the lang attribute on <html>.', 3);
  if (!viewport) add('high', 'Viewport meta tag is missing', 'Add a responsive viewport meta tag.', 8);
  if (!ogTitle || !ogDescription) add('low', 'Open Graph metadata is incomplete', 'Add og:title and og:description for social sharing.', 4);
  if (noindex) add('high', 'Page is marked noindex', 'Remove noindex if this page should appear in search engines.', 20);
  if (imageCount && imageAltCount < imageCount) add('medium', `${imageCount - imageAltCount} image(s) are missing alt attributes`, 'Add useful alt text to meaningful images.', 7);
  if (!jsonLd) add('low', 'No JSON-LD structured data detected', 'Add relevant schema.org JSON-LD where appropriate.', 3);
  if (!pageUrl.startsWith('https://')) add('high', 'Page is not using HTTPS', 'Redirect all traffic to HTTPS.', 10);

  return {
    score: Math.max(0, Math.min(100, score)), title, description, canonical, lang, viewport, h1Count, h2Count,
    imageCount, imageAltCount, jsonLd, noindex, internalLinkCount: internalLinks.length, externalLinkCount: externalLinks.length,
    links, issues, suggestions
  };
}

export function parseRobots(text, status = 200) {
  if (status >= 400) return { exists: false, status, sitemapUrls: [], disallowCount: 0, blocksAll: false };
  const lines = String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const sitemapUrls = lines.filter((x) => /^sitemap\s*:/i.test(x)).map((x) => x.replace(/^sitemap\s*:/i, '').trim());
  const disallow = lines.filter((x) => /^disallow\s*:/i.test(x)).map((x) => x.replace(/^disallow\s*:/i, '').trim());
  return { exists: true, status, sitemapUrls, disallowCount: disallow.filter(Boolean).length, blocksAll: disallow.includes('/') };
}

export function parseSitemap(text, status = 200) {
  if (status >= 400) return { exists: false, status, urlCount: 0, sitemapCount: 0, type: 'missing' };
  const body = String(text || '');
  const urlCount = count(body, /<url\b/gi);
  const sitemapCount = count(body, /<sitemap\b/gi);
  return { exists: true, status, urlCount, sitemapCount, type: sitemapCount ? 'index' : 'urlset' };
}

export function parseCertSpotter(issuances, domain) {
  if (!Array.isArray(issuances) || !issuances.length) return { expiresAt: null, issuer: null, source: 'Cert Spotter CT' };
  const d = String(domain).toLowerCase();
  const matches = issuances.filter((x) => {
    const names = Array.isArray(x?.dns_names) ? x.dns_names.map((n) => String(n).toLowerCase()) : [];
    return !names.length || names.includes(d) || names.includes(`*.${d}`);
  });
  const candidates = (matches.length ? matches : issuances).filter((x) => x?.not_after);
  candidates.sort((a, b) => new Date(b.not_after).getTime() - new Date(a.not_after).getTime());
  const best = candidates[0];
  return { expiresAt: best?.not_after || null, issuer: best?.issuer?.friendly_name || best?.issuer?.name || null, source: 'Cert Spotter CT' };
}

export function fallbackKeywords(audit, domain) {
  const text = `${audit?.title || ''} ${audit?.description || ''}`.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
  const stop = new Set(['the','and','for','with','from','your','this','that','are','was','www','com','https','http','you','our','about','into','have','has']);
  const words = text.split(/\s+/).filter((w) => w.length >= 4 && !stop.has(w));
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  const ranked = [...freq.entries()].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([w]) => w);
  if (ranked.length < 5) ranked.push(...domain.split('.').filter((w) => w.length > 2));
  return [...new Set(ranked)].slice(0, 10);
}
