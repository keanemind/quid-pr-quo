interface TokenData {
  access: string;
  refresh: string;
  expires: number;
}

interface GitHubUser {
  id: number;
  login: string;
}

interface GitHubTokenResponse {
  token: string;
  refresh_token: string;
  expires_in: number;
  user: GitHubUser;
}

interface GitHubOAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

// Verify GitHub webhook signature using Web Crypto API
export async function verifyGitHubSignature(
  body: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const sigHex = signature.replace("sha256=", "");
  const algorithm = { name: "HMAC", hash: "SHA-256" };

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    algorithm,
    false,
    ["sign"]
  );

  const expectedBuffer = await crypto.subtle.sign(
    algorithm.name,
    key,
    new TextEncoder().encode(body)
  );

  const expectedHex = Array.from(new Uint8Array(expectedBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return sigHex === expectedHex;
}

// Create GitHub App JWT for authentication using Web Crypto API
async function createAppJwt(
  appId: string,
  privateKey: string
): Promise<string> {
  console.log("Creating JWT for app ID:", appId);
  const now = Math.floor(Date.now() / 1000);

  // JWT Header
  const header = {
    typ: "JWT",
    alg: "RS256",
  };

  // JWT Payload
  const payload = {
    iat: now - 60, // Issued 60 seconds ago
    exp: now + 600, // Expires in 10 minutes
    iss: appId,
  };

  // Base64url encode header and payload
  const encodedHeader = btoa(JSON.stringify(header))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const encodedPayload = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const message = `${encodedHeader}.${encodedPayload}`;
  console.log("JWT message created, processing key...");

  try {
    // Handle different PEM formats
    let cleanKey = privateKey.trim();

    // Remove PKCS#1 headers if present
    cleanKey = cleanKey
      .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
      .replace(/-----END RSA PRIVATE KEY-----/, "")
      .replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s/g, "");

    console.log("Key cleaned, converting to bytes...");

    // Decode base64 to get DER bytes
    const binaryDer = atob(cleanKey);
    const derBytes = new Uint8Array(binaryDer.length);
    for (let i = 0; i < binaryDer.length; i++) {
      derBytes[i] = binaryDer.charCodeAt(i);
    }

    console.log("Key converted to bytes, attempting import...");

    let cryptoKey;

    // Try PKCS#8 format first (most common for GitHub Apps)
    try {
      console.log("Trying PKCS#8 format...");
      cryptoKey = await crypto.subtle.importKey(
        "pkcs8",
        derBytes,
        {
          name: "RSASSA-PKCS1-v1_5",
          hash: "SHA-256",
        },
        false,
        ["sign"]
      );
      console.log("PKCS#8 import successful");
    } catch (pkcs8Error) {
      console.log("PKCS#8 failed, trying SPKI format...");
      // If PKCS#8 fails, the key might be in a different format
      throw new Error(
        "Key format not supported. Please ensure you're using a PKCS#8 formatted private key."
      );
    }

    console.log("Key imported successfully, signing...");

    // Sign the message
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(message)
    );

    console.log("Message signed, encoding...");

    // Base64url encode the signature
    const encodedSignature = btoa(
      String.fromCharCode(...new Uint8Array(signature))
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    console.log("JWT created successfully");
    return `${message}.${encodedSignature}`;
  } catch (error) {
    console.error("JWT creation failed:", error);
    throw new Error(
      `Failed to create JWT: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

// Exchange OAuth code for user access token
export async function exchangeOAuthCode(
  code: string,
  env: any
): Promise<GitHubTokenResponse> {
  console.log("Exchanging OAuth code for access token...");

  // Use standard GitHub OAuth token exchange
  const tokenResponse = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "quid-pr-quo",
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    }
  );

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("Token exchange failed:", errorText);
    throw new Error(
      `Failed to exchange OAuth code: ${tokenResponse.status} - ${errorText}`
    );
  }

  const tokenData = (await tokenResponse.json()) as GitHubOAuthTokenResponse;
  console.log("Token exchange successful");

  if (tokenData.error) {
    console.error("OAuth error:", tokenData);
    throw new Error(
      `OAuth error: ${tokenData.error_description || tokenData.error}`
    );
  }

  // Get user information
  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "quid-pr-quo",
    },
  });

  if (!userResponse.ok) {
    throw new Error(`Failed to get user info: ${userResponse.status}`);
  }

  const user = (await userResponse.json()) as GitHubUser;

  return {
    token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || "",
    expires_in: tokenData.expires_in || 3600, // Default to 1 hour if not provided
    user: {
      id: user.id,
      login: user.login,
    },
  };
}

// Get user token from storage, refresh if needed
export async function getUserToken(
  userId: string,
  storage: DurableObjectStorage,
  env: any
): Promise<string | null> {
  const tokenData = (await storage.get(`token:${userId}`)) as TokenData | null;

  if (!tokenData) {
    return null;
  }

  // Check if token needs refresh (5 minutes before expiry)
  if (Date.now() > tokenData.expires - 300000) {
    try {
      const refreshedToken = await refreshUserToken(tokenData.refresh, env);

      // Update stored token
      const newTokenData: TokenData = {
        access: refreshedToken.token,
        refresh: refreshedToken.refresh_token || tokenData.refresh,
        expires: Date.now() + refreshedToken.expires_in * 1000,
      };

      await storage.put(`token:${userId}`, newTokenData);
      return newTokenData.access;
    } catch (error) {
      console.error("Failed to refresh token:", error);
      return null;
    }
  }

  return tokenData.access;
}

// Refresh user access token
async function refreshUserToken(
  refreshToken: string,
  env: any
): Promise<GitHubTokenResponse> {
  const appJwt = await createAppJwt(
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY
  );

  // Get installation token
  const tokenResponse = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "quid-pr-quo",
      },
    }
  );

  if (!tokenResponse.ok) {
    throw new Error(
      `Failed to get installation token: ${tokenResponse.status}`
    );
  }

  const tokenResponseData2 = (await tokenResponse.json()) as { token: string };
  const { token: installationToken } = tokenResponseData2;

  // Refresh user token
  const refreshResponse = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/user-access-token`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${installationToken}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "quid-pr-quo",
      },
      body: JSON.stringify({
        refresh_token: refreshToken,
      }),
    }
  );

  if (!refreshResponse.ok) {
    throw new Error(`Failed to refresh user token: ${refreshResponse.status}`);
  }

  return refreshResponse.json();
}

// Approve a PR using user's token
export async function approvePr(
  repoFullName: string,
  prNumber: number,
  userToken: string,
  env: any
): Promise<void> {
  console.log(`🔍 Attempting to approve ${repoFullName}#${prNumber}`);

  // First, check if user already has an approved review
  try {
    const existingReviewsResponse = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/reviews`,
      {
        headers: {
          Authorization: `Bearer ${userToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "quid-pr-quo",
        },
      }
    );

    if (existingReviewsResponse.ok) {
      const reviews = (await existingReviewsResponse.json()) as any[];
      // Get the user info to find their reviews
      const userResponse = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${userToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "quid-pr-quo",
        },
      });

      if (userResponse.ok) {
        const user = (await userResponse.json()) as any;
        const userApprovalReviews = reviews.filter(
          (review: any) =>
            review.user.id === user.id && review.state === "APPROVED"
        );

        if (userApprovalReviews.length > 0) {
          console.log(
            `ℹ️ User ${user.login} already has an approved review for PR #${prNumber}`
          );
          return; // User already approved, no need to re-approve
        }
      }
    }
  } catch (checkError) {
    console.log(
      `⚠️ Could not check existing reviews, proceeding with approval attempt`
    );
  }

  // Proceed with creating a new approval
  const response = await fetch(
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/reviews`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "quid-pr-quo",
      },
      body: JSON.stringify({
        event: "APPROVE",
        body: "Automatic approval via quid-pr-quo escrow exchange",
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    // Handle common scenarios when re-approving
    if (response.status === 422) {
      console.log(`⚠️ Cannot approve PR #${prNumber}: ${errorText}`);
      // This often happens when:
      // 1. User already has a review but reviews were re-requested
      // 2. User doesn't have permission to review
      // 3. PR is already merged/closed

      // Check if it's a "pull request review already submitted" error
      if (
        errorText.includes("already submitted") ||
        errorText.includes("already reviewed") ||
        errorText.includes("review already exists")
      ) {
        console.log(
          `ℹ️ User already has a review for PR #${prNumber}, considering this successful`
        );
        // For now, we'll consider this a success since the intent (approval) is already there
        return;
      }
    }

    throw new Error(
      `Failed to approve PR #${prNumber}: ${response.status} - ${errorText}`
    );
  }

  console.log(`✅ Successfully approved PR #${prNumber}`);
}

// Post a comment to a GitHub issue/PR
export async function postGitHubComment(
  repoFullName: string,
  issueNumber: number,
  comment: string,
  appId: string,
  privateKey: string,
  installationId: string
): Promise<void> {
  console.log(`Posting comment to ${repoFullName}#${issueNumber}`);

  try {
    // Create JWT for app authentication
    const jwt = await createAppJwt(appId, privateKey);

    // Get installation access token
    const tokenResponse = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "quid-pr-quo-worker/1.0",
        },
      }
    );

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(
        `Failed to get access token: ${tokenResponse.status} ${errorText}`
      );
    }

    const tokenData = (await tokenResponse.json()) as { token: string };

    // Post the comment
    const commentResponse = await fetch(
      `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "quid-pr-quo-worker/1.0",
        },
        body: JSON.stringify({
          body: comment,
        }),
      }
    );

    if (!commentResponse.ok) {
      const errorText = await commentResponse.text();
      throw new Error(
        `Failed to post comment: ${commentResponse.status} ${errorText}`
      );
    }

    console.log("✅ Comment posted successfully");
  } catch (error) {
    console.error("❌ Failed to post GitHub comment:", error);
    throw error;
  }
}
