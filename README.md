# PostmanPingBot

> 📬 Instant Telegram alerts for priority Gmail senders, built for Vercel Serverless (100% Free Tier).

PostmanPingBot turns Gmail into real-time Telegram notifications for specific senders or entire domains. It utilizes Google Cloud Pub/Sub push notifications, serverless webhook functions, Upstash Redis, and Vercel Cron.

## ✨ Features

- ⚡ **Instant Alerts**: Google Pub/Sub push events deliver alerts within seconds of email arrival.
- 🎯 **Domain & Sender Matching**: Monitor exact emails (`boss@company.com`) or entire domains (`@bank.com`), matching on real sender headers to prevent display name spoofing.
- 📥 **Recipient Alerts (Forwarders)**: Monitor your own addresses (`hello@shovon.bd`) or a whole domain (`@shovon.bd`) and get pinged for any mail sent TO them, whoever the sender is. Works with forwarded mail (e.g. Cloudflare Email Routing) because the original To address is preserved when mail lands in Gmail. Mail your forwarder blocks never reaches Gmail and cannot alert.
- 🛡️ **Least Privilege (`gmail.metadata`)**: Reads only headers (From, Subject, Date). Email bodies and attachments are never accessible.
- 🔐 **End-to-End Security**:
  - OAuth refresh tokens encrypted in Redis using **AES-256-GCM**.
  - Google Cloud Pub/Sub push webhook verified using Google OIDC JWT signatures.
  - Telegram webhook verified using secret tokens and restricted strictly to your `TELEGRAM_OWNER_ID`.
  - OAuth setup route protected by password and permanently locked after linking.
- 🔄 **Self-Renewing & Catch-up**: A daily Vercel cron job renews the 7-day Gmail watch and performs a 24-hour catch-up scan for missed events.
- 📱 **Telegram Bot Interface**: Manage your watchlist directly from your phone with `/add`, `/remove`, `/list`, `/pause`, `/resume`, `/status`, and `/test`, plus `/addforward` and `/removeforward` for recipient rules. Commands are published to Telegram's `/` menu automatically on startup.

## 🚀 Quick Setup

Check out [SETUP.md](file:///d:/Softw/PostmanPingBot/SETUP.md) for the complete step-by-step setup walkthrough.

## 🧪 Testing

Run the test suite:
```bash
npm test
```

Typecheck:
```bash
npm run typecheck
```
