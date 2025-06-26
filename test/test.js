const assert = require('assert');
const { verifyGitHubSignature } = require('../dist/helpers');
const { EscrowBox } = require('../dist/escrow');

(async () => {
  // verifyGitHubSignature positive
  const secret = 's3cr3t';
  const payload = 'hi';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const hash = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const hex = Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
  const req = new Request('http://x', {method:'POST', body:payload, headers:{'x-hub-signature-256':`sha256=${hex}`}});
  assert.strictEqual(await verifyGitHubSignature(req, secret), true);

  // EscrowBox pledge matching
  const state = { storage: new MapStorage() };
  const env = { APP_PRIVATE_KEY:'', GITHUB_APP_ID:'', GITHUB_APP_INSTALLATION_ID:'' };
  const box = new EscrowBox(state, env);
  await box.fetch(new Request('https://do/pledge',{method:'POST', body:JSON.stringify({user:'a', target:'b', prNumber:1, repo:'r'})}));
  const resp = await box.fetch(new Request('https://do/pledge',{method:'POST', body:JSON.stringify({user:'b', target:'a', prNumber:2, repo:'r'})}));
  const { match } = await resp.json();
  assert.strictEqual(match.prNumber,1);
  console.log('All tests passed');
})();

function MapStorage(){
  const map = new Map();
  this.get = async k => map.get(k);
  this.put = async (k,v)=>{map.set(k,v)};
  this.delete = async k => {map.delete(k)};
  this.transaction = async fn => { await fn(this); };
}
