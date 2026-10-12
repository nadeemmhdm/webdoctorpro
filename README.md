# WEB DOCTOR PRO 🩺

**Your Website Doctor.** WEB DOCTOR PRO is a Telegram-first website monitoring, ownership-verification, audit and reporting platform running on **Cloudflare Workers + D1**.

**Telegram:** `@webdoctorpro_bot`  
**Version:** `1.3.0`  
**Developer:** Nadeem  
**Runtime:** Cloudflare Workers + D1  
**License:** MIT

## Core capabilities

- 🌐 Quick website health checks
- 🛡 DNS TXT ownership verification before monitoring
- ⏱ One-minute uptime monitoring for verified websites
- 🚨 Automatic downtime and recovery alerts
- 📅 Domain-expiry monitoring and reminders
- 🔐 Certificate-expiry monitoring and reminders
- 📈 SEO, GEO and AEO audits with improvement suggestions
- ⚡ PageSpeed Insights checks without requiring the platform owner's API key
- 🔗 Broken-link detection
- 📄 `robots.txt`, sitemap and `llms.txt` analysis
- 🏢 Hosting/CDN, DNS-provider and registrar detection
- 📑 Signed branded PDF full-scan reports
- 🗓 Scheduled daily/weekly/monthly reports according to plan
- 💬 Telegram message reactions and progress animations
- 🪙 Referral coins and plan-extension rewards
- 🎟 Coupon redemption
- ⭐ Telegram Stars recurring subscriptions
- 📣 Admin-managed ads and broadcasts using Telegram-hosted media references only
- 🗄 D1 persistence; no R2 media storage

## Plans

| Plan | Price | Daily checks | Daily PDFs | Monitored sites | Schedules | Ads |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Free | 0 | 5 | 1 | 1 | Weekly | After eligible scans |
| Starter | 49 Stars / 30 days | 25 | 5 | 5 | Daily + weekly | Every 5 eligible scans |
| Pro | 129 Stars / 30 days | 100 | 20 | 25 | Daily + weekly + monthly | None |

Subscriptions use Telegram Stars (`XTR`) recurring invoices with a 30-day subscription period.

## User commands

| Command | Purpose |
| --- | --- |
| `/check example.com` | Quick website health check |
| `/scan example.com` | Full audit + signed PDF |
| `/seo example.com` | SEO/GEO/AEO report |
| `/performance example.com` | PageSpeed report |
| `/ssl example.com` | Certificate-expiry report |
| `/provider example.com` | Hosting/DNS/registrar report |
| `/links example.com` | Broken-link scan |
| `/robots example.com` | Robots/sitemap/llms.txt analysis |
| `/keywords example.com` | Keyword opportunities |
| `/add example.com` | Verify ownership and monitor |
| `/verify example.com` | Re-check DNS TXT verification |
| `/schedule example.com weekly` | Configure signed scheduled reports |
| `/google_setup CLIENT_ID CLIENT_SECRET` | Configure the user's own Google OAuth app |
| `/google` | Authorize the user's own Google account |
| `/analytics example.com PROPERTY_ID` | Map optional Analytics property |
| `/plans` | View plans / pay with Telegram Stars |
| `/invite` | Referral link and rewards |
| `/coins` | Coin balance and redemption |
| `/coupon CODE` | Redeem coupon |
| `/list` | Monitored websites |
| `/remove example.com` | Stop monitoring |
| `/status` | Bot/version/service status |
| `/settings` | Plan, limits, monitoring and connections |

Users can also send a domain directly, such as `example.com`.

## Ownership verification

Monitoring is protected by a unique DNS TXT challenge. The bot generates a record such as:

```text
Type: TXT
Name: _webdoctorpro.example.com
Value: webdoctorpro-verification=<unique-token>
```

Only verified websites can use uptime monitoring, scheduled reports and ownership-sensitive connected data.

## PDF reports

A Full Scan generates a reusable WEB DOCTOR PRO branded PDF template containing:

- health and HTTP status
- domain and certificate expiry
- provider information
- SEO / GEO / AEO scores
- robots / sitemap / llms.txt state
- broken links
- PageSpeed metrics when available
- connected read-only Google metrics when authorized by that user
- prioritized improvements and keyword opportunities
- report ID, generation timestamp and WEB DOCTOR PRO signature metadata

The PDF is generated in memory and sent directly to Telegram. R2 is not used.

## Google integration: user-owned credentials only

WEB DOCTOR PRO does **not** use the platform owner's Google client ID, client secret or PageSpeed API key.

Each user who wants Search Console / optional Analytics integration configures their **own Google Cloud OAuth Web client** and authorizes their own account. Their OAuth client credentials and resulting tokens are encrypted before D1 persistence using the `GOOGLE_TOKEN_KEY` encryption secret.

Redirect URI:

```text
https://webdoctorpro.nadeemmhdm-ai.workers.dev/google/callback
```

PageSpeed Insights runs without a platform API key. Google data is optional; core monitoring works without it.

## Admin platform

Admin commands are scoped to the configured private admin chat. Normal users do not see admin commands in their Telegram command menu.

Admin capabilities include:

- user list and account details
- block / unblock users
- manual Starter / Pro duration grants
- coin adjustments
- coupon create / edit / delete
- automatic coupon expiry and max-use cleanup
- ad create / edit / enable / disable / delete
- global ads on/off
- ad text/image/video/voice support
- dynamic URL buttons
- broadcast text/image/video/voice support
- batched broadcast delivery
- plan and Stars revenue statistics

### Useful admin commands

```text
/admin
/admin_users
/admin_user TELEGRAM_ID
/admin_block TELEGRAM_ID
/admin_unblock TELEGRAM_ID
/admin_grant TELEGRAM_ID pro 30
/admin_coins TELEGRAM_ID 100

/admin_coupons
/admin_coupon_create CODE pro 7 100 2026-12-31 0
/admin_coupon_edit CODE days=14 max=200 active=1
/admin_coupon_delete CODE

/admin_ads
/admin_ad_create
/admin_ad_edit ID
/admin_ad_buttons ID Visit|https://example.com; Docs|https://example.com/docs
/admin_ad_on ID
/admin_ad_off ID
/admin_ad_delete ID
/admin_ads_on
/admin_ads_off

/admin_broadcasts
/admin_broadcast
/admin_broadcast_buttons ID Open|https://example.com
/admin_broadcast_send ID
/admin_broadcast_delete ID
```

Ad/broadcast media bytes are **not copied into D1 or R2**. The database stores Telegram `file_id` references and metadata. Ads are queued for automatic deletion after their display window.

## Referral coins

The bot creates a personal referral link. Current rewards:

- referrer: 25 coins
- new user: 10 coins
- 100 coins → +7 Starter days
- 250 coins → +7 Pro days
- 600 coins → +30 Pro days

## Cloudflare setup

Required secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put GOOGLE_TOKEN_KEY
```

An optional private suggestion service can be configured in Cloudflare without exposing its implementation details in bot messages.

Apply migrations:

```bash
npx wrangler d1 migrations apply webdoctorpro --remote
```

Deploy:

```bash
npx wrangler deploy
```

Production Cron:

```text
* * * * *
```

This drives uptime checks, report scheduling, broadcast batches, coupon cleanup and temporary ad-message cleanup.

## Security notes

- Telegram bot token and webhook secret remain Cloudflare secrets.
- Admin commands are scoped to one Telegram private chat.
- Monitoring requires DNS TXT ownership verification.
- User Google OAuth credentials/tokens are encrypted before D1 persistence.
- Media bytes for ads/broadcasts remain on Telegram infrastructure.
- No R2 bucket is required.
- External reads, HTML size and broken-link crawling are bounded.
- Paid entitlements are granted only after Telegram `successful_payment` updates.
- Blocked users are rejected server-side.

## Development

```bash
npm run check
npm test
```

## License

MIT — see [LICENSE](LICENSE).
