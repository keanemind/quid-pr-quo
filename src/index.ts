import { Router } from 'itty-router'
import type { DurableObjectNamespace, ExecutionContext } from '@cloudflare/workers-types'
import {
  verifyGitHubSignature,
  exchangeOAuthCode,
  approvePr,
  getUserToken
} from './helpers'

export interface Env {
  ESCROW: DurableObjectNamespace
  APP_PRIVATE_KEY: string
  APP_SECRET: string
  GITHUB_APP_ID: string
  GITHUB_APP_INSTALLATION_ID: string
}

const router = Router()

router.post('/webhook', async (req: Request, env: Env) => {
  if (!(await verifyGitHubSignature(req, env.APP_SECRET)))
    return new Response('bad sig', { status: 401 })

  if (req.headers.get('x-github-event') !== 'issue_comment') return new Response('ok')
  const payload = await req.json()
  const body = (payload.comment?.body || '').trim()
  if (!body.startsWith('/escrow-approve')) return new Response('ok')
  if (!payload.issue?.pull_request) return new Response('ok')

  const repo = payload.repository.full_name
  const prNumber = payload.issue.number
  const user = payload.comment.user.login
  const target = payload.issue.user.login

  const stub = env.ESCROW.get(env.ESCROW.idFromName(repo))
  const res = await stub.fetch('https://do/pledge', {
    method: 'POST',
    body: JSON.stringify({ user, target, prNumber, repo })
  })
  const { match } = await res.json()
  if (match) {
    const tokenA = await getUserToken(env, user)
    const tokenB = await getUserToken(env, target)
    await approvePr(repo, prNumber, tokenA)
    await approvePr(match.repo, match.prNumber, tokenB)
  }
  return new Response('ok')
})

router.get('/oauth/callback', async (req: Request, env: Env) => {
  const code = new URL(req.url).searchParams.get('code')
  if (!code) return new Response('Missing code', { status: 400 })
  const tokens = await exchangeOAuthCode(code, env)
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `token ${tokens.access_token}` }
  })
  const { login } = await userRes.json()
  const globalStub = env.ESCROW.get(env.ESCROW.idFromName('tokens'))
  await globalStub.fetch(`https://do/token/${login}`, {
    method: 'PUT',
    body: JSON.stringify({
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Date.now() + tokens.expires_in * 1000
    })
  })
  return new Response('Auth complete, you may close this window.')
})

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => router.handle(req, env, ctx)
}
