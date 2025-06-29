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
      const { userId, tokenData, installationId } = (await request.json()) as {
        userId: string;
        tokenData: TokenData;
        installationId: string;
      };

      // Store token with installation-specific key
      const tokenKey = `token:${userId}:${installationId}`;
      await this.storage.put(tokenKey, tokenData);

      console.log(
        `Token stored for user ${userId} in installation ${installationId}`
      );
      return new Response("Token stored", { status: 200 });
    } catch (error) {
      console.error("Error storing token:", error);
      return new Response("Error storing token", { status: 500 });
    }
  }

  // Process escrow-approve command
  private async handleProcessEscrow(request: Request): Promise<Response> {
    try {
      const {
        userA,
        userAId,
        prNumber,
        repoFullName,
        prAuthor,
        prAuthorId,
        workerUrl,
        installationId,
      } = (await request.json()) as {
        userA: string;
        userAId: string;
        prNumber: number;
        repoFullName: string;
        prAuthor?: string;
        prAuthorId?: string;
        workerUrl: string;
        installationId: string;
      };

      // Use atomic transaction to avoid race conditions
      const result = await this.storage.transaction(async (txn) => {
        // Validate that userA is not the same as prAuthor (can't approve your own PR)
        if (userA === prAuthor) {
          return {
            type: "error",
            message: `❌ @${userA} you cannot use /escrow-approve on your own PR. The escrow system is for mutual approval between different users.`,
          };
        }

        if (!prAuthor || !prAuthorId) {
          return {
            type: "error",
            message: `❌ Could not determine PR author. This might not be a valid PR.`,
          };
        }

        console.log(
          `🔍 Looking for pledge from PR author ${prAuthor} to comment author ${userA}`
        );

        // Look for a pledge from the PR author (prAuthor) offering to approve userA's PR
        const matchingPledgeKey = `pledge:${prAuthor}:${userA}`;
        const matchingPledge = await txn.get<PledgeData>(matchingPledgeKey);

        if (matchingPledge) {
          console.log(
            `🤝 Executing mutual approval: ${prAuthor} approves PR #${prNumber}, ${userA} approves PR #${matchingPledge.prNumber}`
          );

          // Found a match! Execute mutual approval
          const userAToken = await getUserToken(
            userAId,
            this.storage,
            this.env,
            installationId
          );

          const prAuthorToken = await getUserToken(
            prAuthorId,
            this.storage,
            this.env,
            installationId
          );

          if (!userAToken || !prAuthorToken) {
            const oauthUrl = `${workerUrl}/oauth/authorize?state=${installationId}`;
            let errorDetails = "";

            if (!userAToken && !prAuthorToken) {
              errorDetails = `Both @${userA} and @${prAuthor} need to authorize`;
            } else if (!userAToken) {
              errorDetails = `@${userA} needs to authorize`;
            } else {
              errorDetails = `@${prAuthor} needs to authorize`;
            }

            return {
              type: "error",
              message: `${errorDetails} the app for this repository. Visit: ${oauthUrl}`,
            };
          }

          console.log(
            `🚀 Approving PRs: #${prNumber} (${repoFullName}) by ${prAuthor} and #${matchingPledge.prNumber} (${matchingPledge.repo}) by ${userA}`
          );

          // Approve both PRs
          try {
            await Promise.all([
              approvePr(repoFullName, prNumber, userAToken, this.env), // PR author approves userA's PR
              approvePr(
                matchingPledge.repo,
                matchingPledge.prNumber,
                prAuthorToken,
                this.env
              ), // userA approves PR author's PR
            ]);
          } catch (approvalError) {
            console.error("❌ Error during PR approval:", approvalError);
            return {
              type: "error",
              message: `Failed to approve PRs: ${
                approvalError instanceof Error
                  ? approvalError.message
                  : "Unknown error"
              }`,
            };
          }

          // Delete the pledge
          await txn.delete(matchingPledgeKey);

          return {
            type: "success",
            message: `🎉 Mutual approval completed! @${prAuthor} approved @${userA}'s PR #${matchingPledge.prNumber} and @${userA} approved @${prAuthor}'s PR #${prNumber}`,
          };
        } else {
          console.log(
            `📝 No matching pledge found from ${prAuthor}, creating new pledge for ${userA} to approve ${prAuthor}'s PR`
          );

          // No match found, create new pledge from userA offering to approve prAuthor's PR
          // First check if userA has a token
          const userAToken = await getUserToken(
            userAId,
            this.storage,
            this.env,
            installationId
          );
          if (!userAToken) {
            const oauthUrl = `${workerUrl}/oauth/authorize?state=${installationId}`;
            return {
              type: "error",
              message: `@${userA} needs to authorize the app for this repository. Visit: ${oauthUrl}`,
            };
          }

          // Create a pledge from userA offering to approve prAuthor's current PR
          const pledgeKey = `pledge:${userA}:${prAuthor}`;
          const pledgeData: PledgeData = {
            prNumber,
            repo: repoFullName,
            createdAt: Date.now(),
          };

          await txn.put(pledgeKey, pledgeData);

          console.log(
            `✅ Created pledge ${pledgeKey} for ${userA} to approve ${prAuthor}'s PR`
          );

          return {
            type: "pledge",
            message: `⏳ Escrow pledge created! @${userA} is offering to approve @${prAuthor}'s PR #${prNumber}. Now waiting for @${prAuthor} to write /escrow-approve on one of @${userA}'s PRs to complete the mutual approval.`,
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
