# WEB DOCTOR PRO 🩺

WEB DOCTOR PRO is a Telegram-first website monitoring and diagnostics bot running on **Cloudflare Workers + D1**. It monitors domain and SSL expiry, performs SEO checks, identifies common hosting/DNS providers, analyzes `robots.txt` and XML sitemaps, checks a safe sample of internal links, and can optionally use **Ollama Cloud** for SEO keyword suggestions.

**Telegram:** `@webdoctorpro_bot`  
**Version:** `1.1.0`  
**Developer:** Nadeem  
**Runtime:** Cloudflare Workers + D1  
**License:** MIT

## Features

- 📅 Domain expiry lookup using registry RDAP data
- 🚨 Automatic domain-expiry alerts at 30, 14, 7, 3, 1 and 0 days
- 🔐 SSL certificate expiry lookup using public Certificate Transparency data
- 🚨 Automatic SSL-expiry alerts at 30, 14, 7, 3, 1 and 0 days
- 🏢 Hosting/CDN fingerprinting from DNS/CNAME and HTTP response signals
- 🧭 DNS provider detection and registrar information
- 📈 Deterministic on-page SEO scoring with issue/suggestion reports
- 🤖 `robots.txt` analysis and XML sitemap detection
- 🔗 Broken internal-link detection (bounded sample for predictable runtime)
- ✨ Optional AI keyword suggestions through Ollama Cloud
- 🕒 Per-user timezone support for accurate expiry times
- 💬 Easy UX: send a plain domain such as `example.com` without remembering a command
- 🔘 Inline buttons for Full Scan, SEO, SSL, Provider, Broken Links, Keywords and Monitoring
- 🗄 D1 persistence; no R2 media/file storage

## Telegram commands

| Command | Purpose |
| --- | --- |
| `/check example.com` | Quick domain, SSL, availability and provider summary |
| `/scan example.com` | Full website health scan |
| `/seo example.com` | SEO score, issues and recommended fixes |
| `/ssl example.com` | SSL certificate expiry report |
| `/provider example.com` | Hosting, DNS and registrar report |
| `/links example.com` | Broken internal-link check |
| `/robots example.com` | `robots.txt` + XML sitemap analysis |
| `/keywords example.com` | SEO keyword suggestions; Ollama Cloud when configured |
| `/add example.com` | Monitor domain + SSL expiry |
| `/list` | List monitored domains |
| `/remove example.com` | Stop monitoring |
| `/status` | Bot version, developer, GitHub, runtime and service state |
| `/timezone Asia/Kolkata` | Set local timezone |
| `/settings` | View user settings |
| `/help` | Usage guide |

A user can also send `example.com` or `https://example.com/path` directly for a quick check.

## Architecture

```text
Telegram
   │ webhook
   ▼
Cloudflare Worker
   ├── Telegram Bot API
   ├── RDAP registries
   ├── Cloudflare DNS-over-HTTPS
   ├── Website HTTP fetches
   ├── Cert Spotter CT API
   ├── Ollama Cloud API (optional, keywords only)
   └── Cloudflare D1
        ├── users
        ├── domains
        ├── watches
        ├── notifications
        └── app_meta
```

Cloudflare Cron runs once per hour. Domain RDAP information is refreshed on a bounded schedule, while SSL metadata is refreshed less frequently to avoid unnecessary external requests.

## Setup

### 1. Install

```bash
npm install
```

Install Wrangler if it is not already available:

```bash
npm install -D wrangler@latest
```

### 2. Create/apply D1 migrations

The repository includes the original schema plus the website-doctor upgrade migration.

```bash
npx wrangler d1 migrations apply webdoctorpro --remote
```

### 3. Add required Cloudflare secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

Optional Ollama Cloud keyword AI:

```bash
npx wrangler secret put OLLAMA_API_KEY
```

Do **not** put secret values in Git, `wrangler.jsonc`, screenshots, issues or logs.

### 4. Deploy

```bash
npx wrangler deploy
```

The production configuration uses an hourly Cron trigger:

```text
0 * * * *
```

### 5. Telegram webhook

Production webhook path:

```text
/telegram
```

The bot validates Telegram webhook requests using `WEBHOOK_SECRET`.

## Ollama Cloud usage

AI is intentionally kept out of normal diagnostics. SEO scoring, robots/sitemap analysis, SSL/domain checks, provider detection and broken-link checks are deterministic. Ollama Cloud is called only for `/keywords` (or the Keywords button) when `OLLAMA_API_KEY` exists.

Default cloud model:

```text
gpt-oss:20b-cloud
```

It can be changed with the `OLLAMA_MODEL` Worker variable.

## SEO audit checks

The current audit inspects common technical/on-page signals including:

- title presence and approximate length
- meta description presence and approximate length
- H1 count
- canonical URL
- HTML `lang`
- responsive viewport metadata
- Open Graph title/description
- `noindex`
- image `alt` coverage
- JSON-LD structured data
- HTTPS usage
- internal/external link counts

The SEO score is a practical diagnostic score, not a Google ranking score.

## SSL note

SSL expiry is derived from public Certificate Transparency issuance data. This is useful for monitoring and expiry estimates, but it should not be interpreted as a cryptographic verification of the exact certificate currently served by every edge/origin at that instant.

## Broken-link safety

WEB DOCTOR PRO checks a bounded number of internal links per manual run (`15` by default). This keeps Worker execution predictable and avoids aggressive crawling.

## Development

```bash
npm run check
npm test
```

Current test suite covers domain normalization, RDAP parsing, timezone handling, provider detection, SEO analysis, robots/sitemap parsing, SSL certificate parsing and deterministic keyword fallback.

## Security

- Telegram token is a Cloudflare secret.
- Webhook secret is a Cloudflare secret.
- Ollama API key is optional and stored as a Cloudflare secret.
- No secret values are committed to GitHub.
- No R2 bucket is required.
- External HTML reads are size-bounded.
- Broken-link crawling is bounded.
- Telegram callback actions re-validate domains.

## License

MIT — see [LICENSE](LICENSE).
