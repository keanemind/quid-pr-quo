import { Router } from "itty-router";
import {
  verifyGitHubSignature,
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
  const state = url.searchParams.get("state");

  if (!state) {
    return new Response("Missing installation id", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Get the current worker URL to construct the redirect URI
  const workerUrl = new URL(request.url).origin;
  const redirectUri = `${workerUrl}/oauth/callback`;

  // Construct the GitHub OAuth URL with all required parameters
  const githubOAuthUrl = new URL("https://github.com/login/oauth/authorize");
  githubOAuthUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubOAuthUrl.searchParams.set("redirect_uri", redirectUri);
  githubOAuthUrl.searchParams.set("scope", "repo");
  githubOAuthUrl.searchParams.set("state", state);

  // Check if request wants JSON (for API usage)
  const acceptHeader = request.headers.get("accept") || "";
  if (acceptHeader.includes("application/json")) {
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
  }

  // Return mobile-friendly HTML page
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authorize GitHub Access - Quid Pro Quo</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 500px;
            margin: 0 auto;
            padding: 20px;
            background: #f6f8fa;
            color: #24292f;
        }
        .container {
            background: white;
            border-radius: 12px;
            padding: 30px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            text-align: center;
        }
        h1 { color: #0969da; margin-bottom: 20px; }
        .auth-btn {
            background: #238636;
            color: white;
            border: none;
            padding: 15px 30px;
            font-size: 16px;
            border-radius: 8px;
            text-decoration: none;
            display: inline-block;
            margin: 20px 0;
            min-height: 44px;
            line-height: 1.2;
        }
        .auth-btn:hover { background: #2ea043; }
        .details {
            background: #f6f8fa;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
            font-size: 14px;
            color: #656d76;
        }
        .url-display {
            background: #f1f3f4;
            padding: 10px;
            border-radius: 6px;
            font-family: monospace;
            font-size: 12px;
            word-break: break-all;
            margin: 10px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤝 Quid Pro Quo</h1>
        <h2>GitHub Authorization Required</h2>
        <p>To use escrow commands, you need to authorize this app to access your GitHub repositories.</p>
        
        <a href="${githubOAuthUrl.toString()}" class="auth-btn">
            📱 Authorize with GitHub
        </a>
        
        <div class="details">
            <strong>What this does:</strong><br>
            • Grants repository access for escrow commands<br>
            • Allows posting comments on your behalf<br>
            • State: ${state}
        </div>
        
        <details>
            <summary style="cursor: pointer; color: #0969da;">🔧 Troubleshooting (tap to expand)</summary>
            <div style="margin-top: 15px; text-align: left;">
                <strong>If the link doesn't work:</strong><br>
                1. Try copying this URL and pasting it in your browser:<br>
                <div class="url-display">${githubOAuthUrl.toString()}</div>
                2. Make sure you're not in private browsing mode<br>
                3. Try a different browser (Chrome, Firefox)<br>
                4. Disable "Prevent Cross-Site Tracking" in Safari settings<br>
                5. If you have the GitHub app, try "Open in Safari" instead
            </div>
        </details>
    </div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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

  const installationId = state;
  if (!installationId) {
    return new Response("Missing installation id", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    console.log("Attempting to exchange OAuth code...");
    // Exchange code for user access token
    const tokenData = await exchangeOAuthCode(code, env);
    console.log("OAuth exchange successful for user:", tokenData.user.login);

    const objectId = env.ESCROW.idFromName(installationId);
    const escrowBox = env.ESCROW.get(objectId);

    // Store user token in Durable Object with installation ID
    const storeResponse = await escrowBox.fetch(
      "https://fake-host/store-token",
      {
        method: "POST",
        body: JSON.stringify({
          userId: tokenData.user.id.toString(),
          installationId,
          tokenData: {
            access: tokenData.token,
            refresh: tokenData.refresh_token,
            expires: Date.now() + tokenData.expires_in * 1000,
          },
        }),
      }
    );

    if (!storeResponse.ok) {
      const errorText = await storeResponse.text();
      console.error("Failed to store token:", errorText);
      return new Response(
        `Authorization failed: Could not find installation for this repository. Please try using /escrow-approve on a PR first.`,
        {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        }
      );
    }

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

  // Get installation ID from webhook payload (this is repo-specific)
  const installationId = payload.installation?.id;
  if (!installationId) {
    console.log("❌ No installation ID found in webhook payload");
    return new Response("No installation ID found", { status: 400 });
  }

  // Get PR number from issue (GitHub treats PRs as issues)
  const prNumber = payload.issue.number;
  const userA = payload.comment.user.login; // Person writing the comment
  const userAId = payload.comment.user.id.toString();

  // Get PR author (the person who created the PR)
  const prAuthor = payload.issue.user?.login;
  const prAuthorId = payload.issue.user?.id?.toString();

  console.log("Repository:", repoFullName);
  console.log("Installation ID:", installationId);
  console.log("PR/Issue number:", prNumber);
  console.log("Comment author:", userA);
  console.log("PR author:", prAuthor);
  console.log("Is PR:", !!payload.issue.pull_request);

  // Post immediate acknowledgment comment with OAuth link if needed
  try {
    const workerUrl = new URL(request.url).origin;
    const oauthUrl = `${workerUrl}/oauth/authorize?state=${installationId}`;

    await postGitHubComment(
      repoFullName,
      prNumber,
      `👋 @${userA} I received your \`/escrow-approve\` command! Processing...\n\n🔗 If you need to authorize: ${oauthUrl}`,
      env.GITHUB_APP_ID,
      env.GITHUB_APP_PRIVATE_KEY,
      installationId.toString()
    );
  } catch (error) {
    console.error("Failed to post acknowledgment comment:", error);
  }

  // Get Durable Object instance for this repo
  const objectId = env.ESCROW.idFromName(installationId);
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
        prAuthor,
        prAuthorId,
        workerUrl: new URL(request.url).origin,
        installationId: installationId.toString(),
      }),
    });

    const responseText = await response.text();
    console.log("✅ Escrow processing completed");
    console.log("Response status:", response.status);
    console.log("Response body:", responseText);

    // Parse the JSON response to get the message
    let finalMessage = responseText;
    try {
      const jsonResponse = JSON.parse(responseText);
      if (jsonResponse.message) {
        finalMessage = jsonResponse.message;
      }
    } catch (parseError) {
      console.log("Response is not JSON, using as-is");
    }

    // Post result comment
    try {
      await postGitHubComment(
        repoFullName,
        prNumber,
        finalMessage,
        env.GITHUB_APP_ID,
        env.GITHUB_APP_PRIVATE_KEY,
        installationId.toString()
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
        installationId.toString()
      );
    } catch (commentError) {
      console.error("Failed to post error comment:", commentError);
    }

    return new Response("Internal server error", { status: 500 });
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
