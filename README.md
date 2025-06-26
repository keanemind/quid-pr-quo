# Escrow Approval Bot

A minimal Cloudflare Worker + Durable Object that lets two developers trade pull-request approvals using the `/escrow-approve` command.

## Deploy
1. Install [Wrangler](https://developers.cloudflare.com/workers/wrangler/).
2. Fill in secrets:
   ```sh
   wrangler secret put APP_PRIVATE_KEY # GitHub App private key
   wrangler secret put APP_SECRET      # OAuth client secret
   wrangler secret put GITHUB_APP_ID   # numeric App ID
   wrangler secret put GITHUB_APP_INSTALLATION_ID # installation ID
   ```
3. Deploy the worker:
   ```sh
   wrangler deploy
   ```
4. Set your GitHub App webhook URL to `https://<your-worker>/webhook` and OAuth callback to `https://<your-worker>/oauth/callback`.
