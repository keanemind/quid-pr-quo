import { Router } from "itty-router";
import {
  verifyGitHubSignature,
  createAppJwt,
  exchangeOAuthCode,
} from "./utils";
import { EscrowBox } from "./escrow";

export { EscrowBox };

interface Env {
  ESCROW: DurableObjectNamespace;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
}

const router = Router();

// Simple test endpoint
router.get("/test", () => {
  console.log('Test endpoint hit');
  return new Response('Worker is alive!', { status: 200 });
});

// OAuth callback handler
router.get("/oauth/callback", async (request: Request, env: Env) => {
  console.log('=== OAuth callback hit ===');
  console.log('Request URL:', request.url);
  
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  
  console.log('Code present:', !!code);
  console.log('State:', state);

  if (!code) {
    console.log('No code provided, returning 400');
    return new Response("Missing authorization code", { status: 400 });
  }

  try {
    // Exchange code for user access token
    const tokenData = await exchangeOAuthCode(code, env);

    // Get repository from state or default to main repo
    const repoId = state || "default";
    const objectId = env.ESCROW.idFromName(repoId);
    const escrowBox = env.ESCROW.get(objectId);

    // Store user token in Durable Object
    await escrowBox.fetch("/store-token", {
      method: "POST",
      body: JSON.stringify({
        userId: tokenData.user.id.toString(),
        tokenData: {
          access: tokenData.token,
          refresh: tokenData.refresh_token,
          expires: Date.now() + tokenData.expires_in * 1000,
        },
      }),
    });

    return new Response(
      "Authorization successful! You can now use /escrow-approve commands.",
      {
        headers: { "Content-Type": "text/plain" },
      }
    );
  } catch (error) {
    console.error("OAuth error:", error);
    return new Response("Authorization failed", { status: 500 });
  }
});

// GitHub webhook handler
router.post("/webhook", async (request: Request, env: Env) => {
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  // Verify GitHub signature
  if (
    !signature ||
    !(await verifyGitHubSignature(body, signature, env.GITHUB_WEBHOOK_SECRET))
  ) {
    return new Response("Invalid signature", { status: 401 });
  }

  const payload = JSON.parse(body);

  // Only handle issue_comment events
  if (payload.action !== "created" || !payload.comment) {
    return new Response("OK", { status: 200 });
  }

  const comment = payload.comment.body.trim();

  // Check for /escrow-approve command
  if (!comment.startsWith("/escrow-approve")) {
    return new Response("OK", { status: 200 });
  }

  // Extract repository info
  const repo = payload.repository;
  const repoFullName = repo.full_name;
  const repoId = repo.id.toString();

  // Get PR number from issue (GitHub treats PRs as issues)
  const prNumber = payload.issue.number;
  const userA = payload.comment.user.login;
  const userAId = payload.comment.user.id.toString();

  // Get Durable Object instance for this repo
  const objectId = env.ESCROW.idFromName(repoId);
  const escrowBox = env.ESCROW.get(objectId);

  // Process the escrow command
  const response = await escrowBox.fetch("/process-escrow", {
    method: "POST",
    body: JSON.stringify({
      userA,
      userAId,
      prNumber,
      repoFullName,
      repoId,
    }),
  });

  return response;
});

// Default handler
router.all("*", () => new Response("Not Found", { status: 404 }));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    console.log('Worker received request:', request.method, request.url);
    try {
      const response = await router.handle(request, env);
      console.log('Router handled request successfully');
      return response;
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(`Worker error: ${error instanceof Error ? error.message : 'Unknown error'}`, { 
        status: 500 
      });
    }
  },
};
