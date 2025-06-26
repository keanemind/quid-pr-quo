# Quid Pro Quo - GitHub PR Escrow Approval Bot

A GitHub App powered by Cloudflare Durable Objects that enables automatic mutual PR approval exchanges between developers.

## How it works

1. Developer A comments `/escrow-approve` on a PR
2. If Developer B has already pledged on another PR, both PRs get automatically approved
3. If no match exists, a pledge is stored waiting for another developer to match

## 30-Second Deploy Guide

### Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
- GitHub App created (see setup below)

### Quick Deploy

```bash
# 1. Install dependencies
npm install

# 2. Set secrets (replace with your values)
wrangler secret put APP_PRIVATE_KEY
wrangler secret put APP_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_INSTALLATION_ID

# 3. Deploy
wrangler deploy

# 4. Note the deployed URL (e.g., https://quid-pr-quo.your-subdomain.workers.dev)
```

### GitHub App Setup

1. **Create GitHub App**:

   - Go to GitHub Settings > Developer settings > GitHub Apps
   - Click "New GitHub App"
   - Fill in basic info:
     - Name: `quid-pr-quo`
     - Homepage URL: `https://github.com/yourusername/quid-pr-quo`
     - Webhook URL: `https://your-worker.workers.dev/webhook`
     - Webhook secret: Generate a random string

2. **Permissions**:

   - Repository permissions:
     - Pull requests: Read & Write
     - Issues: Read
     - Metadata: Read
   - Subscribe to events:
     - Issue comments

3. **Get credentials**:

   - App ID: Found on the app's general settings page
   - Private key: Generate and download from the app settings
   - Client secret: Generate in the app settings
   - Installation ID: Install the app on a repo, check the URL

4. **Set webhook URL**:
   - Update webhook URL to: `https://your-deployed-worker.workers.dev/webhook`

### Usage

1. **User Authorization**:

   - Users must first authorize via: `https://your-worker.workers.dev/oauth/callback?code=AUTH_CODE`
   - (GitHub will redirect here after OAuth flow)

2. **Making Pledges**:
   - Comment `/escrow-approve` on any PR
   - If someone else has a pending pledge, both PRs get approved automatically
   - Otherwise, your pledge waits for a match

### Environment Variables

Set these via `wrangler secret put <NAME>`:

- `APP_PRIVATE_KEY`: Your GitHub App's private key (PEM format)
- `APP_SECRET`: Your GitHub App's client secret
- `GITHUB_APP_ID`: Your GitHub App's ID
- `GITHUB_APP_INSTALLATION_ID`: Installation ID after installing the app

### Development

```bash
# Local development
npm run dev

# Deploy to production
npm run deploy

# View live logs (helpful for debugging)
wrangler tail

# View live logs with filter
wrangler tail --format=pretty
```

### Architecture

- **Cloudflare Worker**: Handles webhooks and OAuth callbacks
- **Durable Object**: Stores pledges and user tokens per repository
- **GitHub App**: Provides secure access to approve PRs

### Security

- All webhook payloads are verified with HMAC signatures
- User tokens are stored encrypted in Durable Objects
- Automatic token refresh before expiration
- Atomic transactions prevent race conditions

### Limitations

- Only handles `/escrow-approve` commands (must be first token or sole content)
- One Durable Object instance per repository
- Manual cleanup of expired pledges not implemented
- No UI for viewing pending pledges

## TODO

- [ ] Fill in actual GitHub App credentials
- [ ] Add pledge expiration and cleanup
- [ ] Implement target user specification
- [ ] Add audit logging
- [ ] Create management UI
