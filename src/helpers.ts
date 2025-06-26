import jwt from 'jsonwebtoken'

export const verifyGitHubSignature = async (req: Request, secret: string) => {
  const sig = req.headers.get('x-hub-signature-256') || ''
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const body = await req.clone().arrayBuffer()
  const hash = await crypto.subtle.sign('HMAC', key, body)
  const hex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `sha256=${hex}` === sig
}

export const createAppJwt = (appId: string, key: string) => {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign({ iat: now, exp: now + 600, iss: appId }, key, {
    algorithm: 'RS256'
  })
}

export const exchangeOAuthCode = async (code: string, env: any) => {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: env.GITHUB_APP_ID,
      client_secret: env.APP_SECRET,
      code
    })
  })
  return res.json()
}

export const approvePr = async (
  repo: string,
  pr: number,
  token: string
) => {
  await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}/reviews`, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json'
    },
    body: JSON.stringify({ event: 'APPROVE' })
  })
}

export const getUserToken = async (env: any, user: string) => {
  const stub = env.ESCROW.get(env.ESCROW.idFromName('tokens'))
  const res = await stub.fetch(`https://do/token/${user}`)
  if (!res.ok) throw new Error('token missing')
  const { access } = await res.json()
  return access as string
}
