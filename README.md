# WEB DOCTOR PRO

WEB DOCTOR PRO is a Telegram bot that checks domain registration expiry data and automatically warns users before expiry. It is built for Cloudflare Workers and Cloudflare D1, with Telegram used for all chat/media delivery. No R2 storage is required.

## Features

- Check a domain instantly with `/check example.com`
- Monitor domains with `/add example.com`
- Automatic expiry alerts at 30, 14, 7, 3, 1 and 0 days
- Per-user IANA timezone support for accurate local date/time display
- Inline timezone choices plus custom `/timezone Area/City`
- View/remove monitored domains
- Registry RDAP-based expiry, registrar and status lookup
- D1-backed users, domains, watches and deduplicated notifications
- Hourly Cloudflare Cron refresh/notification job
- Secure Telegram webhook secret validation
- Health endpoint for deployment verification
- No R2; Telegram remains the file/media transport if media features are added later

> Domain registries differ: some RDAP servers do not publish an expiry date. In that case the bot reports the value as unavailable rather than inventing a date.

## Bot commands

`/start`, `/help`, `/check <domain>`, `/add <domain>`, `/list`, `/remove <domain>`, `/timezone <Area/City>`, `/time`, `/settings`.

## Architecture

Telegram -> Cloudflare Worker `/telegram` -> D1. Domain metadata is fetched through RDAP. A Cloudflare Cron Trigger invokes the Worker hourly to refresh due domains and send reminders.

## Cloudflare resources

- Worker: `webdoctorpro`
- D1 database: `webdoctorpro`
- D1 binding: `DB`
- Cron: `0 * * * *`
- Required secret: `TELEGRAM_BOT_TOKEN`
- Internal secret: `WEBHOOK_SECRET`

## Setup

1. Install Node.js 20+ and run `npm install -D wrangler@latest`.
2. Authenticate with `npx wrangler login`.
3. Ensure `wrangler.jsonc` points to your D1 database.
4. Apply the schema: `npx wrangler d1 migrations apply webdoctorpro --remote`.
5. Add the Telegram token securely: `npx wrangler secret put TELEGRAM_BOT_TOKEN`.
6. Add a strong webhook secret: `npx wrangler secret put WEBHOOK_SECRET`.
7. Deploy with `npx wrangler deploy`.
8. Configure Telegram `setWebhook` to `https://<worker>.workers.dev/telegram` and pass the same `WEBHOOK_SECRET` as `secret_token`.

Never commit Telegram tokens or webhook secrets.

## Development

Run `npm run check` and `npm test`. For scheduled handler testing with Wrangler, use `npx wrangler dev --test-scheduled`.

## Privacy and storage

The D1 database stores Telegram user/chat identifiers, optional Telegram display metadata, timezone, watched domains, cached RDAP metadata, and notification deduplication records. The bot does not require object storage.

## License

MIT — see `LICENSE`.
