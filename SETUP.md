# 📬 PostmanPingBot Setup Guide

PostmanPingBot provides instant Telegram alerts when emails arrive from specific senders or domains using Gmail push notifications, Google Cloud Pub/Sub, and Vercel Serverless Functions on the 100% free tier.

---

## 🏗️ Architecture Overview

```mermaid
graph TD
    A[New Incoming Email] -->|Gmail watch| B(Google Cloud Pub/Sub Topic)
    B -->|Push HTTP POST with OIDC JWT| C[Vercel: /api/gmail-webhook]
    C -->|Verify JWT & Check Dedup| D[(Upstash Redis)]
    C -->|Fetch Headers Metadata Only| E[Gmail API: messages.get]
    C -->|Match Senders / Domains| F{Matched?}
    F -->|Yes| G[Telegram Alert with Open Link]
    F -->|No| H[Ignore & Ack]
    I[Vercel Cron: Daily] -->|Renew 7-day watch & 24h Catch-up| J[/api/cron/daily]
    K[Telegram User] -->|Commands: /add, /list, /pause| L[/api/telegram-webhook]
```

---

## 📋 Step 1: Telegram Bot Setup

1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, choose a name and username (e.g., `MyPostmanPingBot`).
3. Save the **Bot Token** (`TELEGRAM_BOT_TOKEN`).
4. Search for [@userinfobot](https://t.me/userinfobot) on Telegram and click Start.
5. Copy your numerical **Id** (e.g., `123456789`). This is your `TELEGRAM_OWNER_ID`.
6. Generate a random secret for the webhook header (`TELEGRAM_SECRET_TOKEN`):
   ```bash
   node -e "console.log(crypto.randomBytes(24).toString('hex'))"
   ```

---

## 🗄️ Step 2: Upstash Redis Setup (Free Tier)

1. Go to [Upstash Console](https://console.upstash.com/) and sign in.
2. Click **Create Database**:
   - Name: `postman-ping-bot`
   - Type: Regional (choose the region closest to your Vercel deployment)
   - Free tier selected.
3. Under the database details, scroll to **REST API** section.
4. Copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

---

## ☁️ Step 3: Google Cloud & Gmail Setup

### 3.1 Create Project & Enable APIs
1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g., `postman-ping-bot`).
3. In the search bar, look for **APIs & Services** > **Library**.
4. Enable both:
   - **Gmail API**
   - **Cloud Pub/Sub API**

### 3.2 Configure OAuth Consent Screen
1. Go to **APIs & Services** > **OAuth consent screen**.
2. Select **External** and click **Create**.
3. Fill in:
   - App name: `PostmanPingBot`
   - User support email: your Gmail address
   - Developer contact email: your Gmail address
4. Click **Save and Continue**.
5. Under **Scopes**, click **Add or Remove Scopes**:
   - Search for `https://www.googleapis.com/auth/gmail.metadata`
   - Select it and click **Update** -> **Save and Continue**.
6. Under **Publishing status**:
   > ⚠️ **CRITICAL:** Set the app publishing status to **"In production"**!
   > If left in "Testing" mode, Google will invalidate your refresh token every 7 days and stop alerts. Because only your personal account will authenticate, you don't need Google verification. You will simply accept the unverified app warning once during link setup.

### 3.3 Create OAuth 2.0 Credentials
1. Go to **APIs & Services** > **Credentials**.
2. Click **+ Create Credentials** > **OAuth client ID**.
3. Application type: **Web application**.
4. Name: `PostmanPing Web Client`.
5. Under **Authorized redirect URIs**, add:
   ```text
   https://<your-vercel-domain>.vercel.app/api/oauth/callback
   ```
   *(If deploying locally for testing, you can also add `http://localhost:3000/api/oauth/callback`)*
6. Click **Create**. Copy:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`

### 3.4 Google Cloud Pub/Sub Setup
1. Go to **Pub/Sub** > **Topics**.
2. Click **Create Topic**:
   - Topic ID: `gmail-push-topic`
   - Keep default settings and click **Create**.
3. Grant Gmail permission to publish to your topic:
   - Select the topic you just created (`gmail-push-topic`).
   - In the right-hand panel, click **Permissions** (or **Show Info Panel** -> **Add Principal**).
   - **New principals**: `gmail-api-push@system.gserviceaccount.com`
   - **Role**: `Pub/Sub Publisher` (`roles/pubsub.publisher`)
   - Click **Save**.
4. Copy the full Topic Name (`PUBSUB_TOPIC_NAME`), e.g.:
   ```text
   projects/<your-project-id>/topics/gmail-push-topic
   ```

### 3.5 Create Service Account & Push Subscription
1. Go to **IAM & Admin** > **Service Accounts**.
2. Click **+ Create Service Account**:
   - Service account name: `pubsub-invoker`
   - Click **Create and Continue**, then **Done**.
   - Note the email address: e.g. `pubsub-invoker@<your-project-id>.iam.gserviceaccount.com` (`PUBSUB_SERVICE_ACCOUNT_EMAIL`).
3. Return to **Pub/Sub** > **Subscriptions**.
4. Click **Create Subscription**:
   - Subscription ID: `gmail-push-sub`
   - Select Cloud Pub/Sub topic: choose `gmail-push-topic`
   - Delivery type: **Push**
   - Endpoint URL: `https://<your-vercel-domain>.vercel.app/api/gmail-webhook`
   - Check **Enable authentication**:
     - Service account: select `pubsub-invoker@...`
     - Audience: `https://<your-vercel-domain>.vercel.app/api/gmail-webhook` (`PUBSUB_VERIFICATION_AUDIENCE`)
   - Acknowledgment deadline: `30 seconds`
   - Retain unacknowledged messages: `7 days`
   - Click **Create**.

---

## 🚀 Step 4: Environment Variables & Vercel Deployment

1. Generate your encryption key:
   ```bash
   node -e "console.log(crypto.randomBytes(32).toString('hex'))"
   ```
2. Generate setup password:
   ```bash
   node -e "console.log(crypto.randomBytes(16).toString('hex'))"
   ```
3. Generate cron secret:
   ```bash
   node -e "console.log(crypto.randomBytes(24).toString('hex'))"
   ```
4. In your Vercel project settings (**Settings > Environment Variables**), set:
   | Variable | Description | Example |
   | :--- | :--- | :--- |
   | `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | `123456:ABC-DEF...` |
   | `TELEGRAM_OWNER_ID` | Your Telegram ID from @userinfobot | `987654321` |
   | `TELEGRAM_SECRET_TOKEN` | Secret for Telegram webhook | random string |
   | `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL | `https://...upstash.io` |
   | `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST Token | `AX...` |
   | `GOOGLE_CLIENT_ID` | OAuth Client ID from Google Cloud | `...apps.googleusercontent.com` |
   | `GOOGLE_CLIENT_SECRET` | OAuth Client Secret | `GOCSPX-...` |
   | `GOOGLE_REDIRECT_URI` | Full callback URL | `https://<app>.vercel.app/api/oauth/callback` |
   | `PUBSUB_TOPIC_NAME` | GCP Pub/Sub Topic path | `projects/<id>/topics/gmail-push-topic` |
   | `PUBSUB_SERVICE_ACCOUNT_EMAIL`| Service account email | `pubsub-invoker@<id>.iam...` |
   | `PUBSUB_VERIFICATION_AUDIENCE`| Webhook URL for Pub/Sub | `https://<app>.vercel.app/api/gmail-webhook` |
   | `ENCRYPTION_KEY` | 64-character hex key (AES-256) | `64_hex_characters` |
   | `OAUTH_SETUP_PASSWORD` | Secret for initial OAuth setup | `setup_pass_123` |
   | `CRON_SECRET` | Vercel Cron Secret | `cron_secret_123` |
   | `TZ` | Timezone for notifications | `Asia/Dhaka` |

5. Deploy with the Vercel CLI or by connecting your GitHub repo:
   ```bash
   npx vercel --prod
   ```

---

## 🔗 Step 5: Activate Webhook & Link Gmail

### 5.1 Register Telegram Webhook
Run this in PowerShell or bash (replace placeholders):
```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-vercel-domain>.vercel.app/api/telegram-webhook&secret_token=<TELEGRAM_SECRET_TOKEN>"
```
You should receive:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

### 5.2 Complete One-time Gmail Linking
1. Open your browser and visit:
   ```text
   https://<your-vercel-domain>.vercel.app/api/oauth/start?secret=<OAUTH_SETUP_PASSWORD>
   ```
2. Sign in with the Gmail account you want to monitor.
3. Click **Continue** (bypass the "Google hasn't verified this app" screen by clicking *Advanced* -> *Go to PostmanPingBot (unsafe)*).
4. Grant the metadata permission.
5. You will see the **Google Account Linked!** confirmation page, and your Telegram bot will instantly notify you!
6. The setup route automatically locks itself to prevent unauthorized access.

---

## 💬 Step 6: Using PostmanPingBot

In your private Telegram chat with your bot:

| Command | Action |
| :--- | :--- |
| `/start` | View bot status, watchlist count, and quick help |
| `/add boss@company.com` | Alert on emails from exact address |
| `/add @bank.com` | Alert on any sender from `@bank.com` or its subdomains |
| `/remove boss@company.com` | Remove sender or domain from watchlist |
| `/addforward hello@shovon.bd` | Alert on any mail sent TO this address, whoever sends it |
| `/addforward @shovon.bd` | Alert on mail sent to ANY address on the domain |
| `/removeforward hello@shovon.bd` | Remove a recipient (forwarder) rule |
| `/list` | Show all watched senders & domains, plus recipient rules |
| `/pause` | Temporarily silence all alerts |
| `/resume` | Resume alerts |
| `/status` | View watch expiration, last event received, and sync state |
| `/test` | Send a simulated test alert to verify Telegram formatting |
| `/help` | Display command guide |

---

## 🔒 Security Best Practices Implemented

- **Minimal Gmail Scopes**: Only uses `gmail.metadata`. The bot has **zero access to email bodies or attachments**.
- **AES-256-GCM Encryption**: OAuth refresh tokens in Redis are stored encrypted at rest.
- **Strict OIDC Authentication**: Pub/Sub requests are authenticated using Google's official JWKS certificates verifying issuer, service account email, and audience.
- **Telegram Owner Restriction**: All commands strictly verify `ctx.from.id === TELEGRAM_OWNER_ID`. Messages from any other user are silently dropped.
- **Replay & Timing Attack Resistance**: HMAC-SHA256 signed OAuth state and constant-time string comparison (`crypto.timingSafeEqual`).
- **Idempotency & Deduplication**: Redis `SET NX` with 7-day TTL ensures duplicate delivery from Pub/Sub never produces double alerts.
