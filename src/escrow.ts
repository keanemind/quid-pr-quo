import { getUserToken, approvePr } from "./utils";

interface PledgeData {
  prNumber: number;
  repo: string;
  createdAt: number;
}

interface TokenData {
  access: string;
  refresh: string;
  expires: number;
}

export class EscrowBox {
  private storage: DurableObjectStorage;
  private env: any;

  constructor(state: DurableObjectState, env: any) {
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/store-token" && request.method === "POST") {
      return this.handleStoreToken(request);
    }

    if (url.pathname === "/process-escrow" && request.method === "POST") {
      return this.handleProcessEscrow(request);
    }

    return new Response("Not Found", { status: 404 });
  }

  // Store user OAuth token
  private async handleStoreToken(request: Request): Promise<Response> {
    try {
      const { userId, tokenData } = (await request.json()) as {
        userId: string;
        tokenData: TokenData;
      };

      await this.storage.put(`token:${userId}`, tokenData);
      return new Response("Token stored", { status: 200 });
    } catch (error) {
      console.error("Error storing token:", error);
      return new Response("Error storing token", { status: 500 });
    }
  }

  // Process escrow-approve command
  private async handleProcessEscrow(request: Request): Promise<Response> {
    try {
      const { userA, userAId, prNumber, repoFullName, repoId, workerUrl } =
        (await request.json()) as {
          userA: string;
          userAId: string;
          prNumber: number;
          repoFullName: string;
          repoId: string;
          workerUrl: string;
        };

      // Use atomic transaction to avoid race conditions
      const result = await this.storage.transaction(async (txn) => {
        // Check for existing pledge from any user to userA
        const pledgeKeys = await txn.list({ prefix: `pledges:` });
        let matchingPledge: { key: string; value: PledgeData } | null = null;
        let pledgeFromUser: string | null = null;

        for (const [key, value] of pledgeKeys) {
          const keyParts = key.split(":");
          if (keyParts.length === 3) {
            const fromUser = keyParts[1];
            const toUser = keyParts[2];

            // Check if someone pledged to userA, or if userA pledged to someone else
            if (toUser === userA || fromUser === userA) {
              matchingPledge = { key, value: value as PledgeData };
              pledgeFromUser = fromUser;
              break;
            }
          }
        }

        if (matchingPledge && pledgeFromUser && pledgeFromUser !== userA) {
          // Found a match! Execute mutual approval
          const userAToken = await getUserToken(
            userAId,
            this.storage,
            this.env
          );
          const targetUserToken = await getUserToken(
            pledgeFromUser,
            this.storage,
            this.env
          );

          if (!userAToken || !targetUserToken) {
            const oauthUrl = `${workerUrl}/oauth/authorize?state=${repoId}`;
            return {
              type: "error",
              message: `One or both users need to authorize the app first. Visit: ${oauthUrl}`,
            };
          }

          // Approve both PRs
          await Promise.all([
            approvePr(repoFullName, prNumber, userAToken, this.env),
            approvePr(
              matchingPledge.value.repo,
              matchingPledge.value.prNumber,
              targetUserToken,
              this.env
            ),
          ]);

          // Delete the pledge
          await txn.delete(matchingPledge.key);

          return {
            type: "success",
            message: `Mutual approval executed! PRs #${prNumber} and #${matchingPledge.value.prNumber} have been approved.`,
          };
        } else {
          // No match found, create new pledge
          // First check if userA has a token
          const userAToken = await getUserToken(
            userAId,
            this.storage,
            this.env
          );
          if (!userAToken) {
            const oauthUrl = `${workerUrl}/oauth/authorize?state=${repoId}`;
            return {
              type: "error",
              message: `@${userA} needs to authorize the app first. Visit: ${oauthUrl}`,
            };
          }

          // Create a pledge from userA to any other user
          const pledgeKey = `pledges:${userA}:*`;
          const pledgeData: PledgeData = {
            prNumber,
            repo: repoFullName,
            createdAt: Date.now(),
          };

          await txn.put(pledgeKey, pledgeData);

          return {
            type: "pledge",
            message: `Escrow pledge created for PR #${prNumber}. Waiting for a matching /escrow-approve from another user.`,
          };
        }
      });

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Error processing escrow:", error);
      return new Response("Internal error", { status: 500 });
    }
  }
}
