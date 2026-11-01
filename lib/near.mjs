// Shared NEAR helpers (testnet). Keys come ONLY from environment variables.
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

export const NETWORK = process.env.NEAR_NETWORK || 'testnet';
export const RPC = process.env.NEAR_RPC || 'https://test.rpc.fastnear.com';
export const PURSE = process.env.PURSE_ID || 'agent-leash.testnet';
export const OWNER = process.env.OWNER_ID || 'agent-leash-owner.testnet';
export const toYocto = n => utils.format.parseNearAmount(String(n));
export const toNear = y => utils.format.formatNearAmount(String(y), 4);

export async function accountWithKey(accountId, privateKey) {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(NETWORK, accountId, KeyPair.fromString(privateKey));
  const near = await connect({ networkId: NETWORK, nodeUrl: RPC, keyStore });
  return near.account(accountId);
}

export async function view(method, args = {}) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: PURSE, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
  const j = await r.json();
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
