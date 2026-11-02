// The agent side. It holds ONLY a function-call key on the purse that can call
// `request_payment` and nothing else. It cannot transfer, deploy, add keys or approve.
import { accountWithKey, callReliably, PURSE, toYocto, toNear, readOutcome } from './near.mjs';

// Turn an errand into a payment request. Deliberately obedient: whatever account and
// amount the text names, the agent tries. Safety is not the agent's job here; it is the
// purse's. (That is the point: assume the agent can be fooled.)
export function parseErrand(text) {
  const t = String(text || '').slice(0, 400);
  const amt = t.match(/(\d+(?:\.\d+)?)\s*(?:NEAR|Ⓝ|N\b)/i);
  const acct = t.match(/\b([a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*\.testnet)\b/i);
  if (!amt || !acct) return { error: 'Say an amount in NEAR and a .testnet account, e.g. "pay 0.2 NEAR to upsc-fee-desk.agent-leash-owner.testnet for the form fee".' };
  const memo = t.replace(/\s+/g, ' ').trim().slice(0, 140);
  return { to: acct[1].toLowerCase(), amount: amt[1], memo };
}

export async function requestPayment({ to, amount, memo }) {
  const agent = await accountWithKey(PURSE, process.env.AGENT_KEY);
  const o = await callReliably(agent, 'request_payment', { to, amount: toYocto(amount), memo });
  const { hash, value } = readOutcome(o);
  return { hash, request: value ? { ...value, amount_near: toNear(value.amount) } : null };
}

// Proof the key is leashed: try to move money straight off the purse with the agent's key.
export async function tryDirectTransfer(to, amount) {
  const agent = await accountWithKey(PURSE, process.env.AGENT_KEY);
  try {
    const o = await agent.sendMoney(to, BigInt(toYocto(amount)));
    return { ok: true, hash: readOutcome(o).hash };
  } catch (e) {
    return { ok: false, error: String(e && (e.type || '') + ': ' + (e.message || e)).slice(0, 400) };
  }
}
