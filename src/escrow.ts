import { DurableObject, DurableObjectState } from '@cloudflare/workers-types'
import { createAppJwt } from './helpers'

interface TokenRec {
  access: string
  refresh: string
  expires: number
}

interface Env {
  APP_PRIVATE_KEY: string
  GITHUB_APP_ID: string
  GITHUB_APP_INSTALLATION_ID: string
}

export class EscrowBox implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request) {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/token/')) {
      const user = decodeURIComponent(url.pathname.slice(7))
      if (req.method === 'PUT') {
        const data = await req.json()
        await this.state.storage.put(`token:${user}`, data)
        return new Response('ok')
      }
      let rec = (await this.state.storage.get(`token:${user}`)) as TokenRec | null
      if (!rec) return new Response("missing", { status: 404 })
      if (Date.now() > rec.expires - 300000) {
        const jwt = createAppJwt(this.env.GITHUB_APP_ID, this.env.APP_PRIVATE_KEY)
        const res = await fetch(
          `https://api.github.com/app/installations/${this.env.GITHUB_APP_INSTALLATION_ID}/user-access-token`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${jwt}`,
              Accept: 'application/vnd.github+json'
            },
            body: JSON.stringify({ refresh_token: rec.refresh })
          }
        )
        const upd = await res.json()
        rec = {
          access: upd.token,
          refresh: upd.refresh_token,
          expires: Date.now() + upd.expires_in * 1000
        }
        await this.state.storage.put(`token:${user}`, rec)
      }
      return Response.json({ access: rec.access })
    }

    if (url.pathname === '/pledge' && req.method === 'POST') {
      const { user, target, prNumber, repo } = await req.json()
      let match: any = null
      await this.state.storage.transaction(async (txn: any) => {
        match = await txn.get(`pledges:${target}:${user}`)
        if (match) {
          await txn.delete(`pledges:${target}:${user}`)
        } else {
          await txn.put(`pledges:${user}:${target}`, {
            prNumber,
            repo,
            createdAt: Date.now()
          })
        }
      })
      return Response.json({ match })
    }

    return new Response('not found', { status: 404 })
  }
}
