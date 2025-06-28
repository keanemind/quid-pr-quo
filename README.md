# 🤝 Quid PR Quo - GitHub PR Approval Escrow Service

A solution to "I'll review your PR after you review mine": Fair PR approval exchanges between developers.

## How it works

1. Developer A comments `/escrow-approve` on Developer B's PR. This doesn't approve the PR yet.
2. Once Developer B comments `/escrow-approve` on one of Developer A's PRs, both PRs get approved.

## Quick start

### Install the app

1. **Install on your repository**: [Install Quid Pro Quo GitHub App](https://github.com/apps/quid-pr-quo/installations/new)

   - Choose which repositories to give access to
   - Complete the installation

2. **Use in PRs**: Comment `/escrow-approve` on any PR to start the escrow process.

3. **Authorize when prompted**: If needed, the app will provide an OAuth link for authorization. This allows the app to approve PRs on your behalf.

## Self-host guide

### Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
- GitHub App created (see setup below)

### Deploy

```bash
# 1. Install dependencies
npm install

# 2. Set secrets (replace with your values)
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GITHUB_CLIENT_ID # OAuth Client ID (starts with Iv)
wrangler secret put GITHUB_APP_ID # App ID (numeric)
wrangler secret put GITHUB_APP_INSTALLATION_ID

# 3. Deploy
wrangler deploy

# 4. Note the deployed URL (e.g., https://quid-pr-quo.your-subdomain.workers.dev)
```

### GitHub app setup

1. **Create GitHub app**:

   - Go to GitHub Settings > Developer settings > GitHub Apps
   - Click "New GitHub App"
   - Fill in basic info:
     - Name: `your-app-name`
     - Homepage URL: `https://example.com`
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
   - App Client ID: Found on the app's general settings page
   - Private key: Generate and download from the app settings
   - Client secret: Generate in the app settings
   - Installation ID: Install the app on a repo, check the URL

4. **Set webhook URL**:
   - Update webhook URL to: `https://your-worker.workers.dev/webhook`
