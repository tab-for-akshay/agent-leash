// Shared NEAR helpers (testnet). Keys come ONLY from environment variables.
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

export const NETWORK = process.env.NEAR_NETWORK || 'testnet';
export const RPCS = (process.env.NEAR_RPC ? [process.env.NEAR_RPC] : []).concat(['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']);
export const RPC = RPCS[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
// JSON-RPC with retry + fallback: public RPCs rate-limit (429) under load.
export async function rpc(method, params) {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = RPCS[attempt % RPCS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (r.status === 429 || (j.error && (j.error.code === -429 || /rate limit/i.test(j.error.message || '')))) { last = new Error('rate limited by ' + url); await sleep(400 * (attempt + 1)); continue; }
      return j;
    } catch (e) { last = e; await sleep(400 * (attempt + 1)); }
  }
  throw last;
}
export const PURSE = process.env.PURSE_ID || 'agent-leash.testnet';
export const OWNER = process.env.OWNER_ID || 'agent-leash-owner.testnet';
export const toYocto = n => utils.format.parseNearAmount(String(n));
export const toNear = y => utils.format.formatNearAmount(String(y), 4);

export async function accountWithKey(accountId, privateKey) {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(NETWORK, accountId, KeyPair.fromString(privateKey));
  const near = await connect({ networkId: NETWORK, nodeUrl: RPC, keyStore, provider: { type: 'FailoverRpcProvider', args: RPCS.map(url => ({ url })) } });
  return near.account(accountId);
}

// One RPC endpoint, no failover wrapper: the failover provider reports a protocol refusal as
// "RetriesExceeded", which hides the real reason in the demo.
export async function accountWithKeyAt(accountId, privateKey, url) {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(NETWORK, accountId, KeyPair.fromString(privateKey));
  const near = await connect({ networkId: NETWORK, nodeUrl: url, keyStore });
  return near.account(accountId);
}

export async function view(method, args = {}) {
  const j = await rpc('query', { request_type: 'call_function', finality: 'optimistic', account_id: PURSE, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error || j.result.error).slice(0, 300));
  return JSON.parse(Buffer.from(j.result.result).toString());
}

// Pull the contract's return value and the tx hash out of an outcome.
export function readOutcome(o) {
  const hash = o?.transaction?.hash || o?.transaction_outcome?.id;
  let value = null;
  const s = o?.status;
  if (s && s.SuccessValue !== undefined && s.SuccessValue !== '') { try { value = JSON.parse(Buffer.from(s.SuccessValue, 'base64').toString()); } catch {} }
  return { hash, value };
}

// Send a function call so that it lands exactly once, even under load:
// one send at a time per process; the SAME signed tx is re-broadcast on transient
// errors (NEAR dedupes by hash, so a re-broadcast can't pay twice); only a nonce
// clash with no record of the earlier tx leads to a fresh signature.
let chain = Promise.resolve();
export function callReliably(account, methodName, args, gas = '50000000000000', deposit = 0n) {
  const job = chain.then(() => sendReliably(account, methodName, args, gas, deposit));
  chain = job.catch(() => {});
  return job;
}
const transient = m => /429|rate limit|Exceeded \d+ providers|timeout|TIMEOUT|ECONNRESET|fetch failed|503|502/i.test(m);
const lastNonce = {};
export async function signFresh(account, methodName, args, gas, deposit) {
  const { transactions } = await import('near-api-js');
  return signActions(account, PURSE, [transactions.functionCall(methodName, args, BigInt(gas), BigInt(deposit))]);
}
export async function signActions(account, receiverId, actions) {
  const { transactions, utils } = await import('near-api-js');
  const signer = account.connection.signer;
  const pk = await signer.getPublicKey(account.accountId, NETWORK);
  const ak = await rpc('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: account.accountId, public_key: pk.toString() });
  if (!ak.result || ak.result.error) throw new Error('AccessKeyNotFound: ' + JSON.stringify(ak.error || ak.result.error).slice(0, 200));
  const key = account.accountId + pk.toString();
  const nonce = BigInt(Math.max(Number(ak.result.nonce), lastNonce[key] || 0)) + 1n;
  lastNonce[key] = Number(nonce);
  const block = await rpc('block', { finality: 'final' });
  if (!block.result) throw new Error('block: rate limit');
  const tx = transactions.createTransaction(account.accountId, pk, receiverId, nonce, actions, utils.serialize.base_decode(block.result.header.hash));
  return transactions.signTransaction(tx, signer, account.accountId, NETWORK);
}
async function sendReliably(account, methodName, args, gas, deposit) {
  const { transactions } = await import('near-api-js');
  let lastErr;
  for (let sign = 0; sign < 6; sign++) {
    let signed, hash;
    try { [hash, signed] = await signFresh(account, methodName, args, gas, deposit); }
    catch (e) { lastErr = e; if (transient(String(e.message || e))) { await sleep(700 * (sign + 1)); continue; } throw e; }
    const b64 = Buffer.from(signed.encode()).toString('base64');
    for (let b = 0; b < 5; b++) {
      let j;
      try { j = await rpc('broadcast_tx_commit', [b64]); } catch (e) { lastErr = e; if (process.env.LEASH_DEBUG) console.error('rpc throw', String(e)); await sleep(800 * (b + 1)); continue; }
      if (j.result) {
        const f = j.result.status && j.result.status.Failure;
        if (f) { const err = new Error(JSON.stringify(f).slice(0, 400)); err.outcome = j.result; throw err; }
        return j.result;
      }
      const em = JSON.stringify(j.error || {});
      lastErr = new Error(em.slice(0, 400));
      if (process.env.LEASH_DEBUG) console.error('send error', sign, b, em.slice(0, 300));
      if (/InvalidNonce/.test(em)) {
        // did an earlier broadcast of this very tx land? then that is the answer
        const st = await rpc('tx', [(await import('near-api-js')).utils.serialize.base_encode(hash), account.accountId]).catch(() => null);
        if (st && st.result) return st.result;
        await sleep(300 + Math.random() * 700); break;   // re-sign with a fresh nonce
      }
      if (transient(em) || /TIMEOUT_ERROR/.test(em)) { await sleep(800 * (b + 1)); continue; }
      throw lastErr;  // a real refusal (bad key, wrong method, ...)
    }
  }
  throw lastErr;
}

// One raw send (no retries): the protocol's own verdict, for tests and the bypass demo.
export async function sendRaw(account, receiverId, actions) {
  const [, signed] = await signActions(account, receiverId, actions);
  const j = await rpc('broadcast_tx_commit', [Buffer.from(signed.encode()).toString('base64')]);
  if (j.result && !(j.result.status && j.result.status.Failure)) return { ok: true, result: j.result };
  const why = j.error ? (j.error.data || j.error.cause || j.error) : j.result.status.Failure;
  return { ok: false, error: JSON.stringify(why).slice(0, 300) };
}
