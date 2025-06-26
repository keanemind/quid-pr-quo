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
  GITHUB_CLIENT_ID: string; // OAuth Client ID (starts with Iv)
  GITHUB_APP_ID: string; // App ID (numeric)
  GITHUB_APP_INSTALLATION_ID: string;
}

const router = Router();

// Root endpoint - simple welcome message
router.get("/", () => {
  return new Response("🤝 Quid Pro Quo - GitHub PR Escrow Service", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
});

// Simple test endpoint
router.get("/test", () => {
  console.log("Test endpoint hit");
  return new Response("Worker is alive!", { status: 200 });
});

// OAuth authorization URL generator
router.get("/oauth/authorize", (request: Request, env: Env) => {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "default";

  // Get the current worker URL to construct the redirect URI
  const workerUrl = new URL(request.url).origin;
  const redirectUri = `${workerUrl}/oauth/callback`;

  // Construct the GitHub OAuth URL with all required parameters
  const githubOAuthUrl = new URL("https://github.com/login/oauth/authorize");
  githubOAuthUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubOAuthUrl.searchParams.set("redirect_uri", redirectUri);
  githubOAuthUrl.searchParams.set("scope", "repo");
  githubOAuthUrl.searchParams.set("state", state);

  return new Response(
    JSON.stringify({
      authorization_url: githubOAuthUrl.toString(),
      redirect_uri: redirectUri,
      state: state,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
});

// OAuth callback handler
router.get("/oauth/callback", async (request: Request, env: Env) => {
  console.log("=== OAuth callback hit ===");
  console.log("Request URL:", request.url);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  console.log("Code present:", !!code);
  console.log("State:", state);
  console.log("Error:", error);

  // Handle OAuth errors from GitHub
  if (error) {
    console.log("OAuth error from GitHub:", error, errorDescription);
    return new Response(
      `OAuth authorization failed: ${error}${
        errorDescription ? ` - ${errorDescription}` : ""
      }`,
      {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      }
    );
  }

  if (!code) {
    console.log("No code provided, returning 400");
    return new Response("Missing authorization code", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    console.log("Attempting to exchange OAuth code...");
    // Exchange code for user access token
    const tokenData = await exchangeOAuthCode(code, env);
    console.log("OAuth exchange successful for user:", tokenData.user.login);

    // Get repository from state or default to main repo
    const repoId = state || "default";
    const objectId = env.ESCROW.idFromName(repoId);
    const escrowBox = env.ESCROW.get(objectId);

    // Store user token in Durable Object
    await escrowBox.fetch("https://fake-host/store-token", {
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
      `[SUCCESS] Authorization successful for ${tokenData.user.login}! You can now use /escrow-approve commands.`,
      {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }
    );
  } catch (error) {
    console.error("OAuth error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return new Response(`Authorization failed: ${errorMessage}`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
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
  const response = await escrowBox.fetch("https://fake-host/process-escrow", {
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

// Debug endpoint to check environment configuration
router.get("/debug/env", (request: Request, env: Env) => {
  return new Response(
    JSON.stringify({
      app_id: env.GITHUB_APP_ID,
      client_id: env.GITHUB_CLIENT_ID || "NOT_SET",
      installation_id: env.GITHUB_APP_INSTALLATION_ID,
      has_private_key: !!env.GITHUB_APP_PRIVATE_KEY,
      has_client_secret: !!env.GITHUB_CLIENT_SECRET,
      has_webhook_secret: !!env.GITHUB_WEBHOOK_SECRET,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
});

// Default handler
router.all("*", () => new Response("Not Found", { status: 404 }));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    console.log("Worker received request:", request.method, request.url);
    try {
      const response = await router.fetch(request, env);
      console.log("Router handled request successfully");
      return response;
    } catch (error) {
      console.error("Worker error:", error);
      return new Response(
        `Worker error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        {
          status: 500,
        }
      );
    }
  },
};
