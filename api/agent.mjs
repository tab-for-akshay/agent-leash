// POST /api/agent  {errand}            -> agent asks the purse to pay
// POST /api/agent  {direct: true}      -> agent tries to bypass the purse (must fail)
import { parseErrand, requestPayment, tryDirectTransfer } from '../lib/agent.mjs';

const hits = new Map();
function limited(ip) {
  const now = Date.now(), w = (hits.get(ip) || []).filter(t => now - t < 60000);
  w.push(now); hits.set(ip, w);
  return w.length > 6;
}
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function POST(req) {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0] || 'x';
  if (limited(ip)) return J({ error: 'Slow down: 6 requests a minute per visitor.' }, 429);
  let body = {};
  try { body = await req.json(); } catch {}
  if (!process.env.AGENT_KEY) return J({ error: 'agent key not configured' }, 500);
  const t0 = Date.now();
  try {
    if (body.direct) {
      const r = await tryDirectTransfer('drain-wallet.testnet', '0.01');
      return J({ kind: 'direct', ...r, ms: Date.now() - t0 });
    }
    const p = parseErrand(body.errand);
    if (p.error) return J({ error: p.error }, 400);
    const r = await requestPayment(p);
    return J({ kind: 'request', parsed: p, ...r, ms: Date.now() - t0 });
  } catch (e) {
    return J({ error: String(e && e.message || e).slice(0, 400), ms: Date.now() - t0 }, 502);
  }
}
export async function GET() { return J({ ok: true, purse: process.env.PURSE_ID || 'agent-leash.testnet', hint: 'POST {errand} or {direct:true}' }); }
