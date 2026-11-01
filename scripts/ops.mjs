#!/usr/bin/env node
// Owner/operator script. Keys come from env: PURSE_KEY (purse full-access key, setup only),
// OWNER_KEY (owner account), AGENT_PUBLIC_KEY (the agent's function-call key to install).
// Usage: node scripts/ops.mjs <deploy|init|payees|agentkey|revoke|fund|approve ID|reject ID|pause|unpause|policy A B C [N]|upgrade WASM|lock|summary>
import fs from 'fs';
import { accountWithKey, view, PURSE, OWNER, toYocto, toNear, readOutcome } from '../lib/near.mjs';

const [cmd, ...a] = process.argv.slice(2);
const GAS = '100000000000000';
const owner = () => accountWithKey(OWNER, process.env.OWNER_KEY);
const call = async (methodName, args = {}, deposit = '0') => {
  const acc = await owner();
  const o = await acc.functionCall({ contractId: PURSE, methodName, args, gas: GAS, attachedDeposit: deposit });
  return readOutcome(o);
};
const PAYEES = [
  ['upsc-fee-desk.' + OWNER, 'UPSC exam fee desk (demo payee)'],
  ['bookshop.' + OWNER, 'Bookshop for Botany texts (demo payee)'],
];

if (cmd === 'deploy') {
  const purse = await accountWithKey(PURSE, process.env.PURSE_KEY);
  const o = await purse.deployContract(fs.readFileSync(a[0] || 'contract/target/near/agent_leash.wasm'));
  console.log('deployed', readOutcome(o).hash);
} else if (cmd === 'init') {
  const purse = await accountWithKey(PURSE, process.env.PURSE_KEY);
  const o = await purse.functionCall({ contractId: PURSE, methodName: 'new', args: { owner: OWNER, per_payment_limit: toYocto(a[0] || 1), daily_limit: toYocto(a[1] || 2), approval_above: toYocto(a[2] || 0.5), max_requests_per_day: Number(a[3] || 30) }, gas: GAS });
  console.log('init', readOutcome(o).hash);
} else if (cmd === 'payees') {
  const acc = await owner();
  for (const [id, label] of PAYEES) {
    try { await acc.createAccount(id, (await acc.connection.signer.getPublicKey(OWNER, acc.connection.networkId)), toYocto(0.05)); console.log('created', id); } catch (e) { console.log('create', id, String(e.message).slice(0, 80)); }
    console.log('allowlisted', id, (await call('add_payee', { account: id, label })).hash);
  }
} else if (cmd === 'agentkey') {
  console.log('agent key', (await call('add_agent_key', { public_key: process.env.AGENT_PUBLIC_KEY, gas_allowance: toYocto(a[0] || 1) })).hash);
} else if (cmd === 'revoke') {
  console.log('revoked', (await call('revoke_agent_key', { public_key: process.env.AGENT_PUBLIC_KEY })).hash);
} else if (cmd === 'fund') {
  const acc = await owner();
  const o = await acc.functionCall({ contractId: PURSE, methodName: 'deposit', args: {}, gas: GAS, attachedDeposit: toYocto(a[0] || 3) });
  console.log('funded', readOutcome(o).hash);
} else if (cmd === 'approve' || cmd === 'reject') {
  const r = await call(cmd, { id: Number(a[0]) });
  console.log(cmd, r.hash, JSON.stringify(r.value));
} else if (cmd === 'pause' || cmd === 'unpause') {
  console.log(cmd, (await call('set_paused', { paused: cmd === 'pause' })).hash);
} else if (cmd === 'policy') {
  console.log('policy', (await call('set_policy', { per_payment_limit: toYocto(a[0]), daily_limit: toYocto(a[1]), approval_above: toYocto(a[2]), max_requests_per_day: a[3] ? Number(a[3]) : null })).hash);
} else if (cmd === 'upgrade') {
  const code = fs.readFileSync(a[0] || 'contract/target/near/agent_leash.wasm').toString('base64');
  console.log('upgrade', (await call('upgrade', { code })).hash);
} else if (cmd === 'lock') {
  // Remove the purse's own full-access key: after this only the contract's rules move money.
  const purse = await accountWithKey(PURSE, process.env.PURSE_KEY);
  const o = await purse.deleteKey(process.env.PURSE_PUBLIC_KEY);
  console.log('locked', readOutcome(o).hash);
} else {
  const s = await view('summary');
  console.log(JSON.stringify({ ...s, balance: toNear(s.balance), spent_today: toNear(s.spent_today), left_today: toNear(s.left_today) }, null, 1));
  console.log(JSON.stringify(await view('get_requests', { limit: 10 }), null, 1));
}
