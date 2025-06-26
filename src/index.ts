import { Router } from "itty-router";
import {
  verifyGitHubSignature,
  createAppJwt,
  exchangeOAuthCode,
  postGitHubComment,
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
  console.log("=== WEBHOOK RECEIVED ===");
  console.log("Headers:", Object.fromEntries(request.headers.entries()));

  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  const eventType = request.headers.get("x-github-event");

  console.log("Event type:", eventType);
  console.log("Body length:", body.length);
  console.log("Has signature:", !!signature);

  // Verify GitHub signature
  if (
    !signature ||
    !(await verifyGitHubSignature(body, signature, env.GITHUB_WEBHOOK_SECRET))
  ) {
    console.log("❌ SIGNATURE VERIFICATION FAILED");
    console.log("Expected signature format: sha256=...");
    console.log("Received signature:", signature);
    return new Response("Invalid signature", { status: 401 });
  }

  console.log("✅ Signature verified successfully");

  const payload = JSON.parse(body);
  console.log("Payload action:", payload.action);
  console.log("Has comment:", !!payload.comment);

  // Only handle issue_comment events
  if (eventType !== "issue_comment") {
    console.log(`ℹ️  Ignoring event type: ${eventType}`);
    return new Response("OK", { status: 200 });
  }

  if (payload.action !== "created") {
    console.log(`ℹ️  Ignoring action: ${payload.action}`);
    return new Response("OK", { status: 200 });
  }

  if (!payload.comment) {
    console.log("❌ No comment found in payload");
    return new Response("OK", { status: 200 });
  }

  const comment = payload.comment.body.trim();
  console.log("Comment body:", comment);

  // Check for /escrow-approve command
  if (!comment.startsWith("/escrow-approve")) {
    console.log(`ℹ️  Comment doesn't start with /escrow-approve: "${comment}"`);
    return new Response("OK", { status: 200 });
  }

  console.log("🎯 ESCROW COMMAND DETECTED!");

  // Extract repository info
  const repo = payload.repository;
  const repoFullName = repo.full_name;
  const repoId = repo.id.toString();

  // Get PR number from issue (GitHub treats PRs as issues)
  const prNumber = payload.issue.number;
  const userA = payload.comment.user.login;
  const userAId = payload.comment.user.id.toString();

  console.log("Repository:", repoFullName);
  console.log("PR/Issue number:", prNumber);
  console.log("User:", userA);
  console.log("Is PR:", !!payload.issue.pull_request);

  // Post immediate acknowledgment comment
  try {
    await postGitHubComment(
      repoFullName,
      prNumber,
      `👋 @${userA} I received your \`/escrow-approve\` command! Processing...`,
      env.GITHUB_APP_ID,
      env.GITHUB_APP_PRIVATE_KEY,
      env.GITHUB_APP_INSTALLATION_ID
    );
  } catch (error) {
    console.error("Failed to post acknowledgment comment:", error);
  }

  // Get Durable Object instance for this repo
  const objectId = env.ESCROW.idFromName(repoId);
  const escrowBox = env.ESCROW.get(objectId);

  console.log("🏗️  Processing escrow command...");

  try {
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

    const responseText = await response.text();
    console.log("✅ Escrow processing completed");
    console.log("Response status:", response.status);
    console.log("Response body:", responseText);

    // Post result comment
    try {
      await postGitHubComment(
        repoFullName,
        prNumber,
        `✅ Escrow command processed successfully!\n\n${responseText}`,
        env.GITHUB_APP_ID,
        env.GITHUB_APP_PRIVATE_KEY,
        env.GITHUB_APP_INSTALLATION_ID
      );
    } catch (error) {
      console.error("Failed to post result comment:", error);
    }

    return new Response(responseText, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    console.error("❌ Error processing escrow command:", error);

    // Post error comment
    try {
      await postGitHubComment(
        repoFullName,
        prNumber,
        `❌ Error processing escrow command: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        env.GITHUB_APP_ID,
        env.GITHUB_APP_PRIVATE_KEY,
        env.GITHUB_APP_INSTALLATION_ID
      );
    } catch (commentError) {
      console.error("Failed to post error comment:", commentError);
    }

    return new Response("Internal server error", { status: 500 });
  }
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
      webhook_url: "https://quid-pr-quo.keanemind.workers.dev/webhook",
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
});

// Webhook test endpoint - accepts any POST without signature verification
router.post("/webhook-test", async (request: Request, env: Env) => {
  console.log("🧪 WEBHOOK TEST ENDPOINT HIT!");
  console.log("Headers:", Object.fromEntries(request.headers.entries()));

  const body = await request.text();
  console.log("Body length:", body.length);
  console.log("User-Agent:", request.headers.get("user-agent"));

  try {
    const payload = JSON.parse(body);
    console.log("Event type:", request.headers.get("x-github-event"));
    console.log("Action:", payload.action);
    if (payload.comment) {
      console.log("Comment:", payload.comment.body);
    }
  } catch (e) {
    console.log("Failed to parse JSON, raw body:", body.substring(0, 200));
  }

  return new Response("Webhook test received!", { status: 200 });
});

// Test GitHub App connectivity
router.get("/test-github-app", async (request: Request, env: Env) => {
  try {
    console.log("Testing GitHub App connectivity...");
    const jwt = await createAppJwt(
      env.GITHUB_APP_ID,
      env.GITHUB_APP_PRIVATE_KEY
    );

    // Test the app authentication
    const appResponse = await fetch("https://api.github.com/app", {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "quid-pr-quo-worker/1.0",
      },
    });

    if (!appResponse.ok) {
      const error = await appResponse.text();
      return new Response(`App auth failed: ${appResponse.status} ${error}`, {
        status: 500,
      });
    }

    const appData = (await appResponse.json()) as any;

    // Test installation access
    const installResponse = await fetch(
      `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "quid-pr-quo-worker/1.0",
        },
      }
    );

    if (!installResponse.ok) {
      const error = await installResponse.text();
      return new Response(
        `Installation check failed: ${installResponse.status} ${error}`,
        { status: 500 }
      );
    }

    const installData = (await installResponse.json()) as any;

    return new Response(
      JSON.stringify({
        app: {
          id: appData.id,
          name: appData.name,
          owner: appData.owner.login,
        },
        installation: {
          id: installData.id,
          account: installData.account.login,
          repositories_selection: installData.repository_selection,
        },
        status: "✅ GitHub App is working correctly!",
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("GitHub App test failed:", error);
    return new Response(
      `Test failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      {
        status: 500,
      }
    );
  }
});

// Default handler
router.all("*", () => new Response("Not Found", { status: 404 }));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const timestamp = new Date().toISOString();
    console.log(
      `[${timestamp}] 🚀 Worker received request:`,
      request.method,
      request.url
    );

    // Log headers for webhook debugging
    if (request.url.includes("/webhook")) {
      console.log(
        "🪝 Webhook request headers:",
        Object.fromEntries(request.headers.entries())
      );
    }

    try {
      const response = await router.fetch(request, env);
      console.log(
        `[${timestamp}] ✅ Router handled request successfully - Status:`,
        response.status
      );
      return response;
    } catch (error) {
      console.error(`[${timestamp}] ❌ Worker error:`, error);
      console.error(
        "Error stack:",
        error instanceof Error ? error.stack : "No stack trace"
      );
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
