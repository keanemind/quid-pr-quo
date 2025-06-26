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
export async function createAppJwt(
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
  console.log("JWT message created, importing key...");

  try {
    // Convert PEM to DER format for Web Crypto API
    const pemContents = privateKey
      .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
      .replace(/-----END RSA PRIVATE KEY-----/, "")
      .replace(/\s/g, "");

    // Decode base64 to get DER bytes
    const binaryDer = atob(pemContents);
    const derBytes = new Uint8Array(binaryDer.length);
    for (let i = 0; i < binaryDer.length; i++) {
      derBytes[i] = binaryDer.charCodeAt(i);
    }

    console.log("Key converted to DER format, importing...");

    // Try PKCS#8 format first (GitHub's format)
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      derBytes,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["sign"]
    );

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
  const appJwt = await createAppJwt(
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY
  );

  // First, exchange the code for an app installation access token
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

  const tokenResponseData = (await tokenResponse.json()) as { token: string };
  const { token: installationToken } = tokenResponseData;

  // Now exchange the OAuth code for user access token
  const userTokenResponse = await fetch(
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
        code,
        client_id: env.GITHUB_APP_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
      }),
    }
  );

  if (!userTokenResponse.ok) {
    throw new Error(
      `Failed to exchange OAuth code: ${userTokenResponse.status}`
    );
  }

  return userTokenResponse.json();
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
    throw new Error(`Failed to approve PR: ${response.status} - ${errorText}`);
  }
}
