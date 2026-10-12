export function normalizeDomain(input) {
  const raw = String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/\.$/, '');
  if (!raw || raw.length > 253 || raw.includes(' ') || !raw.includes('.')) throw new Error('Invalid domain');
  const hostname = new URL(`http://${raw}`).hostname;
  if (!/^[a-z0-9.-]+$/.test(hostname) || hostname.includes('..') || hostname.startsWith('.') || hostname.endsWith('.')) throw new Error('Invalid domain');
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
  if (h.server?.includes('nginx')) return 'Nginx origin (provider hidden)';
  if (h.server?.includes('apache')) return 'Apache origin (provider hidden)';
  return 'Unknown / hidden';
}

function matchOne(html, re) { return re.exec(html)?.[1]?.trim() || ''; }
function count(html, re) { return (html.match(re) || []).length; }
function stripTags(html) { return String(html || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim(); }

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
  const wordCount = stripTags(html).split(/\s+/).filter(Boolean).length;

  let score = 100;
  const issues = [];
  const suggestions = [];
  const add = (severity, issue, suggestion, penalty) => { issues.push({ severity, issue }); suggestions.push(suggestion); score -= penalty; };
  if (!title) add('high', 'Missing page title', 'Add a unique title tag.', 15);
  else if (title.length < 30 || title.length > 60) add('medium', `Title length is ${title.length} characters`, 'Keep the title roughly 30-60 characters.', 5);
  if (!description) add('high', 'Missing meta description', 'Add a descriptive meta description.', 15);
  else if (description.length < 70 || description.length > 160) add('medium', `Meta description length is ${description.length} characters`, 'Keep the meta description roughly 70-160 characters.', 5);
  if (h1Count === 0) add('high', 'No H1 heading found', 'Add one clear H1 describing the page topic.', 10);
  else if (h1Count > 1) add('medium', `${h1Count} H1 headings found`, 'Prefer one primary H1 per page.', 5);
  if (!canonical) add('medium', 'Canonical URL is missing', 'Add a canonical link tag.', 5);
  if (!lang) add('low', 'HTML language is missing', 'Set the lang attribute on html.', 3);
  if (!viewport) add('high', 'Viewport meta tag is missing', 'Add a responsive viewport meta tag.', 8);
  if (!ogTitle || !ogDescription) add('low', 'Open Graph metadata is incomplete', 'Add og:title and og:description for social sharing.', 4);
  if (noindex) add('high', 'Page is marked noindex', 'Remove noindex if this page should appear in search engines.', 20);
  if (imageCount && imageAltCount < imageCount) add('medium', `${imageCount - imageAltCount} image(s) are missing alt attributes`, 'Add useful alt text to meaningful images.', 7);
  if (!jsonLd) add('low', 'No JSON-LD structured data detected', 'Add relevant schema.org JSON-LD where appropriate.', 3);
  if (!pageUrl.startsWith('https://')) add('high', 'Page is not using HTTPS', 'Redirect all traffic to HTTPS.', 10);
  if (wordCount < 200) add('low', `Thin homepage content (${wordCount} words)`, 'Add concise, useful content that clearly explains the page topic and intent.', 4);

  return {
    score: Math.max(0, Math.min(100, score)), title, description, canonical, lang, viewport, h1Count, h2Count,
    imageCount, imageAltCount, jsonLd, noindex, wordCount, internalLinkCount: internalLinks.length, externalLinkCount: externalLinks.length,
    links, issues, suggestions
  };
}

export function analyzeGeoAeo(html, audit, { llmsTxt = false } = {}) {
  const src = String(html || '');
  const lower = src.toLowerCase();
  const schemaTypes = [...src.matchAll(/["']@type["']\s*:\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const hasFaqSchema = schemaTypes.some((x) => /faqpage/i.test(x));
  const hasHowTo = schemaTypes.some((x) => /howto/i.test(x));
  const hasOrg = schemaTypes.some((x) => /organization|localbusiness|person|article|product/i.test(x));
  const hasBreadcrumb = schemaTypes.some((x) => /breadcrumblist/i.test(x));
  const questionHeadings = count(src, /<h[1-4]\b[^>]*>[^<]{0,120}\?\s*<\/h[1-4]>/gi);
  const hasAuthor = /\bauthor\b|rel\s*=\s*["']author|property\s*=\s*["']article:author/i.test(src);
  const hasDate = /datepublished|datemodified|article:published_time|<time\b/i.test(src);
  const hasAbout = /\babout us\b|\bwho we are\b|\bour team\b/i.test(lower);
  const hasContact = /\bcontact us\b|mailto:|tel:/i.test(lower);
  const hasCitations = (audit?.externalLinkCount || 0) >= 2;
  const conciseAnswers = count(src, /<p\b[^>]*>[^<]{80,500}<\/p>/gi) >= 2;

  let aeo = 100, geo = 100;
  const aeoSuggestions = [], geoSuggestions = [];
  const aeoCut = (n, s) => { aeo -= n; aeoSuggestions.push(s); };
  const geoCut = (n, s) => { geo -= n; geoSuggestions.push(s); };

  if (!audit?.jsonLd) aeoCut(20, 'Add structured data that matches the page content.');
  if (!hasFaqSchema && !hasHowTo && questionHeadings === 0) aeoCut(20, 'Add clear question-and-answer sections where they naturally fit.');
  if (!conciseAnswers) aeoCut(15, 'Use short, direct answer paragraphs before deeper explanations.');
  if (!audit?.h1Count || !audit?.h2Count) aeoCut(15, 'Use a clear heading hierarchy so answers are easy to extract.');
  if (!hasBreadcrumb) aeoCut(10, 'Add breadcrumb structured data on hierarchical pages.');
  if (!audit?.lang) aeoCut(5, 'Declare the page language.');

  if (!hasOrg) geoCut(20, 'Add Organization/Person/Product/Article schema where relevant.');
  if (!hasAuthor) geoCut(15, 'Add clear author or responsible-entity information.');
  if (!hasDate) geoCut(10, 'Expose published/updated dates for content that changes over time.');
  if (!hasAbout || !hasContact) geoCut(15, 'Strengthen entity trust with clear About and Contact information.');
  if (!hasCitations) geoCut(10, 'Reference authoritative external sources where factual claims benefit from citations.');
  if (!llmsTxt) geoCut(5, 'Consider a concise llms.txt file if it fits your publishing strategy.');
  if (!audit?.canonical) geoCut(5, 'Use canonical URLs consistently.');

  return {
    aeoScore: Math.max(0, aeo), geoScore: Math.max(0, geo), schemaTypes: [...new Set(schemaTypes)].slice(0, 12),
    questionHeadings, hasAuthor, hasDate, llmsTxt, aeoSuggestions, geoSuggestions
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
  if (!Array.isArray(issuances) || !issuances.length) return { expiresAt: null, issuer: null, source: 'Certificate Transparency' };
  const d = String(domain).toLowerCase();
  const matches = issuances.filter((x) => {
    const names = Array.isArray(x?.dns_names) ? x.dns_names.map((n) => String(n).toLowerCase()) : [];
    return !names.length || names.includes(d) || names.includes(`*.${d}`);
  });
  const candidates = (matches.length ? matches : issuances).filter((x) => x?.not_after);
  candidates.sort((a, b) => new Date(b.not_after).getTime() - new Date(a.not_after).getTime());
  const best = candidates[0];
  return { expiresAt: best?.not_after || null, issuer: best?.issuer?.friendly_name || best?.issuer?.name || null, source: 'Certificate Transparency' };
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

export function normalizeTxtRecord(value) {
  return String(value || '').replace(/"\s+"/g, '').replace(/^"|"$/g, '').replace(/\\"/g, '"').trim();
}

export function parsePageSpeed(data) {
  const cats = data?.lighthouseResult?.categories || {};
  const audits = data?.lighthouseResult?.audits || {};
  const score = (name) => cats[name]?.score == null ? null : Math.round(cats[name].score * 100);
  const ms = (name) => audits[name]?.numericValue == null ? null : Math.round(audits[name].numericValue);
  return {
    performance: score('performance'), seo: score('seo'), accessibility: score('accessibility'), bestPractices: score('best-practices'),
    fcpMs: ms('first-contentful-paint'), lcpMs: ms('largest-contentful-paint'), tbtMs: ms('total-blocking-time'),
    cls: audits['cumulative-layout-shift']?.numericValue == null ? null : Number(audits['cumulative-layout-shift'].numericValue.toFixed(3)),
    speedIndexMs: ms('speed-index')
  };
}

export function scheduleIntervalMs(frequency) {
  if (frequency === 'daily') return 86400000;
  if (frequency === 'weekly') return 7 * 86400000;
  if (frequency === 'monthly') return 30 * 86400000;
  return null;
}

function pdfSafeText(value) {
  return String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
}
function pdfEscape(value) { return pdfSafeText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
function wrapPdfText(value, width = 88) {
  const words = pdfSafeText(value).split(/\s+/).filter(Boolean);
  const lines = []; let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if ((line + ' ' + word).length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export function buildReportPdf(report) {
  const title = `WEB DOCTOR PRO - Website Health Report - ${report.domain}`;
  const reportId = report.reportId || `WDP-${Date.now().toString(36).toUpperCase()}`;
  const blocks = [];
  const h1 = (text) => blocks.push({ text, size: 18, bold: true, gap: 12 });
  const h2 = (text) => blocks.push({ text, size: 13, bold: true, gap: 8 });
  const p = (text) => blocks.push({ text, size: 9.5, bold: false, gap: 4 });
  const kv = (key, value) => blocks.push({ text: `${key}: ${value ?? 'Not available'}`, size: 9.5, bold: false, gap: 3 });

  h1('WEB DOCTOR PRO');
  p('Website Health, SEO, GEO and AEO Report');
  kv('Domain', report.domain);
  kv('Report ID', reportId);
  kv('Generated', report.generatedLocal || report.generatedAt || new Date().toISOString());
  kv('Ownership', report.verified ? 'DNS verified' : 'Not verified');
  p('');

  h2('Executive Summary');
  kv('Website status', report.siteStatus || 'Unknown');
  kv('SEO score', report.seo?.score == null ? 'Not available' : `${report.seo.score}/100`);
  kv('GEO score', report.geoAeo?.geoScore == null ? 'Not available' : `${report.geoAeo.geoScore}/100`);
  kv('AEO score', report.geoAeo?.aeoScore == null ? 'Not available' : `${report.geoAeo.aeoScore}/100`);
  kv('PageSpeed mobile', report.pageSpeed?.performance == null ? 'Not available' : `${report.pageSpeed.performance}/100`);
  kv('Hosting/CDN', report.hostingProvider || 'Unknown');
  kv('DNS provider', report.dnsProvider || 'Unknown');
  kv('Registrar', report.registrar || 'Not published');

  h2('Domain and Certificate');
  kv('Domain expiry', report.domainExpiryLocal || 'Not published');
  kv('Certificate expiry', report.sslExpiryLocal || 'Not available');
  kv('Certificate issuer', report.sslIssuer || 'Not available');

  h2('SEO Findings');
  kv('Title', report.seo?.title || 'Missing');
  kv('Meta description', report.seo?.description || 'Missing');
  kv('H1 count', report.seo?.h1Count ?? 0);
  kv('H2 count', report.seo?.h2Count ?? 0);
  kv('Word count', report.seo?.wordCount ?? 0);
  kv('Internal links', report.seo?.internalLinkCount ?? 0);
  kv('External links', report.seo?.externalLinkCount ?? 0);
  (report.seo?.issues || []).slice(0, 12).forEach((x) => p(`[${String(x.severity || 'info').toUpperCase()}] ${x.issue}`));

  h2('GEO and AEO Findings');
  kv('Structured-data types', (report.geoAeo?.schemaTypes || []).join(', ') || 'None detected');
  kv('Question headings', report.geoAeo?.questionHeadings ?? 0);
  kv('Author signals', report.geoAeo?.hasAuthor ? 'Found' : 'Not detected');
  kv('Freshness/date signals', report.geoAeo?.hasDate ? 'Found' : 'Not detected');
  kv('llms.txt', report.geoAeo?.llmsTxt ? 'Found' : 'Not found');
  (report.geoAeo?.geoSuggestions || []).slice(0, 6).forEach((x) => p(`GEO: ${x}`));
  (report.geoAeo?.aeoSuggestions || []).slice(0, 6).forEach((x) => p(`AEO: ${x}`));

  h2('Robots, Sitemap and Links');
  kv('robots.txt', report.robots?.exists ? `Found (HTTP ${report.robots.status})` : 'Missing');
  kv('Crawler blocked', report.robots?.blocksAll ? 'Yes' : 'No');
  kv('Sitemap', report.sitemap?.exists ? `Found (${report.sitemap.type})` : 'Missing');
  kv('Sitemap URLs detected', report.sitemap?.urlCount ?? 0);
  kv('Internal links checked', report.links?.checked ?? 0);
  kv('Broken links found', report.links?.broken?.length ?? 0);
  (report.links?.broken || []).slice(0, 10).forEach((x) => p(`${x.status || 'ERR'} ${x.url}`));

  if (report.pageSpeed) {
    h2('PageSpeed Insights');
    kv('Performance', report.pageSpeed.performance == null ? 'Not available' : `${report.pageSpeed.performance}/100`);
    kv('SEO', report.pageSpeed.seo == null ? 'Not available' : `${report.pageSpeed.seo}/100`);
    kv('Accessibility', report.pageSpeed.accessibility == null ? 'Not available' : `${report.pageSpeed.accessibility}/100`);
    kv('Best practices', report.pageSpeed.bestPractices == null ? 'Not available' : `${report.pageSpeed.bestPractices}/100`);
    kv('LCP', report.pageSpeed.lcpMs == null ? 'Not available' : `${report.pageSpeed.lcpMs} ms`);
    kv('CLS', report.pageSpeed.cls == null ? 'Not available' : report.pageSpeed.cls);
    kv('TBT', report.pageSpeed.tbtMs == null ? 'Not available' : `${report.pageSpeed.tbtMs} ms`);
  }

  if (report.searchConsole) {
    h2('Google Search Console - Last 28 Days');
    kv('Clicks', report.searchConsole.clicks ?? 0);
    kv('Impressions', report.searchConsole.impressions ?? 0);
    kv('CTR', report.searchConsole.ctr == null ? 'Not available' : `${(report.searchConsole.ctr * 100).toFixed(2)}%`);
    kv('Average position', report.searchConsole.position == null ? 'Not available' : Number(report.searchConsole.position).toFixed(2));
    (report.searchConsole.topQueries || []).slice(0, 10).forEach((q) => p(`Query: ${q.query} | clicks ${q.clicks} | impressions ${q.impressions} | position ${Number(q.position || 0).toFixed(1)}`));
  }

  if (report.analytics) {
    h2('Google Analytics - Last 28 Days');
    kv('Active users', report.analytics.activeUsers ?? 'Not available');
    kv('Sessions', report.analytics.sessions ?? 'Not available');
    kv('Engagement rate', report.analytics.engagementRate == null ? 'Not available' : `${(Number(report.analytics.engagementRate) * 100).toFixed(2)}%`);
  }

  h2('Priority Improvement Plan');
  (report.recommendations || []).slice(0, 12).forEach((x, i) => p(`${i + 1}. ${x}`));
  h2('Suggested Keywords');
  p((report.keywords || []).join(', ') || 'No keyword suggestions available.');

  h2('Report Signature');
  p('Generated by WEB DOCTOR PRO. Developer: Nadeem.');
  p('Source repository: https://github.com/nadeemmhdm/webdoctorpro');
  p(`Bot signature: WEB-DOCTOR-PRO/${report.version || 'unknown'} | Report ${reportId}`);

  const pageWidth = 595, pageHeight = 842, left = 48, top = 782, bottom = 56;
  const pages = []; let current = [], y = top;
  const footerReserve = 32;
  const pushLine = (text, size, bold, gap) => {
    const lineHeight = size + 4;
    if (y - lineHeight < bottom + footerReserve) { pages.push(current); current = []; y = top; }
    current.push({ text, x: left, y, size, bold });
    y -= lineHeight + gap;
  };
  for (const block of blocks) {
    const width = block.size >= 16 ? 52 : block.size >= 12 ? 70 : 94;
    const lines = wrapPdfText(block.text, width);
    lines.forEach((line, idx) => pushLine(line, block.size, block.bold, idx === lines.length - 1 ? block.gap : 0));
  }
  if (current.length || !pages.length) pages.push(current);

  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  const pageIds = [], contentIds = [];
  let nextId = 5;
  for (let i = 0; i < pages.length; i++) { pageIds.push(nextId++); contentIds.push(nextId++); }
  const infoId = nextId++;
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  pages.forEach((lines, idx) => {
    const footer = `WEB DOCTOR PRO | Developer Nadeem | github.com/nadeemmhdm/webdoctorpro | ${reportId} | Page ${idx + 1}/${pages.length}`;
    const ops = [];
    for (const line of lines) {
      const font = line.bold ? 'F2' : 'F1';
      ops.push(`BT /${font} ${line.size} Tf 1 0 0 1 ${line.x} ${line.y} Tm (${pdfEscape(line.text)}) Tj ET`);
    }
    ops.push(`BT /F1 7.5 Tf 1 0 0 1 48 30 Tm (${pdfEscape(footer)}) Tj ET`);
    const stream = ops.join('\n');
    const streamLength = new TextEncoder().encode(stream).length;
    objects[contentIds[idx]] = `<< /Length ${streamLength} >>\nstream\n${stream}\nendstream`;
    objects[pageIds[idx]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentIds[idx]} 0 R >>`;
  });

  const created = new Date(report.generatedAt || Date.now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  objects[infoId] = `<< /Title (${pdfEscape(title)}) /Author (WEB DOCTOR PRO - Developer Nadeem) /Creator (WEB DOCTOR PRO ${pdfEscape(report.version || '')}) /Producer (WEB DOCTOR PRO PDF Report Engine) /Subject (${pdfEscape(`Signed website audit report ${reportId} for ${report.domain}`)}) /Keywords (website health, SEO, GEO, AEO, uptime, domain, SSL, WEB DOCTOR PRO) /CreationDate (D:${created}) >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = new TextEncoder().encode(pdf).length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return { bytes: new TextEncoder().encode(pdf), reportId };
}
