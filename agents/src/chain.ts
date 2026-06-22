// On-chain layer: reads agents/markets and builds + signs the hire (PTB #1) and
// resolve (PTB #2) transactions with the backend keypair (= the wallet + auditor operator).
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { deployment as d, env } from "./config.js";
import type { TaskClass } from "./tasks.js";
import { readMidPrice, readLevel2, addCancelAllOrders, addLimitOrder, addDeposit } from "./deepbook.js";

const PKG = d.packageId as string;
const STABLE = d.stablecoin.type as string;

export const keypair = Ed25519Keypair.deriveKeypair(env.mnemonic);
export const ME = keypair.toSuiAddress();
// Separate protocol treasury address (account #1 of the same seed) — receives the take-rate.
export const TREASURY = Ed25519Keypair.deriveKeypair(env.mnemonic, "m/44'/784'/0'/0'/1'").toSuiAddress();
export const client = new SuiClient({ url: env.rpc });

const TAKE_BPS = 1000; // 10% protocol fee on each task
const PREMIUM_LOAD = 1.2; // 20% underwriting margin baked into the premium

// Running protocol revenue (this session): take-rate fees + underwriting margin.
// Underwriting margin = premiums − payouts + slashed bonds. The agent's bond covers its
// own failures, so a covered claim costs the protocol ~nothing; only an uncovered loss
// (bond exhausted) dents revenue.
const revenue = { feesUsdc: 0, premiumsUsdc: 0, payoutsUsdc: 0, slashedUsdc: 0 };
export const getRevenue = () => {
  const netInsuranceUsdc = +(revenue.premiumsUsdc - revenue.payoutsUsdc + revenue.slashedUsdc).toFixed(2);
  return {
    feesUsdc: +revenue.feesUsdc.toFixed(2),
    premiumsUsdc: +revenue.premiumsUsdc.toFixed(2),
    payoutsUsdc: +revenue.payoutsUsdc.toFixed(2),
    slashedUsdc: +revenue.slashedUsdc.toFixed(2),
    netInsuranceUsdc,
    totalUsdc: +(revenue.feesUsdc + netInsuranceUsdc).toFixed(2),
    treasury: TREASURY,
  };
};

const bytes = (s: string) => Array.from(new TextEncoder().encode(s));

// One wallet signs every tx, so serialize them to avoid gas-coin equivocation when a
// trade and a hire/resolve land at the same time. All exec() calls run one at a time.
let txQueue: Promise<unknown> = Promise.resolve();

// Recent on-chain activity (orders, hires, resolves…) for the history feed.
export interface Activity { ts: number; kind: string; label: string; digest: string }
const activityLog: Activity[] = [];
export const getActivity = () => activityLog.slice(0, 50);

async function exec(tx: Transaction, kind = "tx", label = "") {
  const run = txQueue.then(async () => {
    tx.setGasBudget(200_000_000);
    const res = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showObjectChanges: true, showEffects: true, showEvents: true },
    });
    await client.waitForTransaction({ digest: res.digest });
    if (res.effects?.status?.status !== "success")
      throw new Error(`tx failed: ${JSON.stringify(res.effects?.status)}`);
    activityLog.unshift({ ts: Date.now(), kind, label, digest: res.digest });
    if (activityLog.length > 100) activityLog.pop();
    return res;
  });
  txQueue = run.catch(() => {}); // keep the chain alive even if one tx fails
  return run;
}

const num = (v: any) => (v && typeof v === "object" && "value" in v ? Number(v.value) : Number(v));

// Genuine crypto task-classes. Old toy agents (on clause/invoice/citation) are not in
// this set, so they're automatically excluded from the marketplace.
const KNOWN = new Set(["move-audit", "coin-safety", "route", "general", "wallet-report", "token-brief", "defi-health"]);
const CURATED = new Set(["MovePackageAuditor", "CoinSafetyChecker", "RouteOptimizer", "NaiveRouter", "GeneralBot", "WalletReporter", "TokenAnalyst", "DeFiHealthChecker"]);
// New task-classes reuse an existing DeepBook pool for their live reliability market
// (avoids republishing + new pool-creation DEEP).
const POOL_FOR: Record<string, string> = { "move-audit": "clause", "coin-safety": "citation", route: "invoice" };
const poolEntry = (taskClass: string) => d.taskClasses[POOL_FOR[taskClass] ?? taskClass];

export async function readAgentById(id: string) {
  const o = await client.getObject({ id, options: { showContent: true } });
  const f = (o.data?.content as any)?.fields;
  if (!f) return null;
  return {
    id,
    taskClass: String.fromCharCode(...((f.task_class as number[]) || [])),
    name: f.name as string,
    owner: f.owner as string,
    reliabilityBps: num(f.reliability_cached),
    bondUsdc: num(f.bond) / 1e6,
    jobs: num(f.jobs_total),
    fails: num(f.jobs_failed),
    isAuditor: !!f.is_auditor,
  };
}

/** All registered worker agents (incl. user-published ones), via AgentRegistered events. */
export async function listAgents() {
  const evs = await client.queryEvents({
    query: { MoveEventType: `${PKG}::agent_registry::AgentRegistered` },
    limit: 100,
    order: "ascending",
  });
  const seen = new Set<string>();
  const out: any[] = [];
  for (const e of evs.data) {
    const pj = e.parsedJson as any;
    if (pj.is_auditor || seen.has(pj.agent_id)) continue;
    seen.add(pj.agent_id);
    const a = await readAgentById(pj.agent_id);
    // Curated first-party set (public creation is disabled). Hides one-off test registrations.
    if (a && KNOWN.has(a.taskClass) && CURATED.has(a.name)) out.push(a);
  }
  // Always ranked by success score (on-chain reliability), tie-broken by proven track record.
  out.sort((a, b) => b.reliabilityBps - a.reliabilityBps || b.jobs - a.jobs || a.fails - b.fails);
  return out;
}

export const leaderboard = listAgents;

/** Publish a new agent on-chain: register identity + stake a bond. Permissionless. */
export async function createAgent(name: string, taskClass: string, bondUsdc: number, reliabilityBps = 9000) {
  const tx = new Transaction();
  const usdc = tx.object(await pickUsdcCoin());
  const [bond] = tx.splitCoins(usdc, [tx.pure.u64(BigInt(Math.round(bondUsdc * 1e6)))]);
  tx.moveCall({
    target: `${PKG}::agent_registry::register_agent`,
    typeArguments: [STABLE],
    arguments: [
      tx.object(d.agentRegistryId),
      tx.pure.string(name),
      tx.pure.vector("u8", bytes(taskClass)),
      bond,
      tx.pure.u64(BigInt(reliabilityBps)),
    ],
  });
  const res = await exec(tx, "register", `list ${name}`);
  return { digest: res.digest, agentId: created(res, "::agent_registry::Agent<") };
}

async function pickUsdcCoin(): Promise<string> {
  const { data } = await client.getCoins({ owner: ME, coinType: STABLE });
  if (!data.length) throw new Error("no mock USDC — run the seed script");
  return data.sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)))[0].coinObjectId;
}

const created = (res: any, t: string) =>
  (res.objectChanges || []).find((c: any) => c.type === "created" && c.objectType?.includes(t))?.objectId;

/** PTB #1: take the platform fee + buy the policy (premium → reserve). The agent's fee
 *  is NOT paid yet — it's ESCROWED and settled at resolve (paid to the agent on PASS,
 *  refunded to the user on FAIL). `feeUsdc` is the price the agent owner set. */
export async function hire(agentId: string, withGuarantee: boolean, feeUsdc = 5) {
  const agent = await readAgentById(agentId);
  if (!agent) throw new Error("agent not found");
  const fee = BigInt(Math.round(feeUsdc * 1e6));
  const protocolCut = (fee * BigInt(TAKE_BPS)) / 10000n; // platform take-rate (kept)
  const agentCut = fee - protocolCut; // escrowed until the verdict
  const coverage = withGuarantee ? agentCut : 0n;
  const premium = withGuarantee ? BigInt(Math.round(Number(coverage) * (1 - agent.reliabilityBps / 10000) * PREMIUM_LOAD)) : 0n;

  const tx = new Transaction();
  const usdc = tx.object(await pickUsdcCoin());
  const [protoCoin] = tx.splitCoins(usdc, [tx.pure.u64(protocolCut)]);
  tx.transferObjects([protoCoin], tx.pure.address(TREASURY)); // platform fee → treasury
  const [prem] = tx.splitCoins(usdc, [tx.pure.u64(premium)]);
  tx.moveCall({
    target: `${PKG}::insurance::buy_policy`,
    typeArguments: [STABLE],
    arguments: [
      tx.object(d.reservePoolId),
      tx.pure.address(agent.id),
      tx.pure.vector("u8", bytes(agent.taskClass)),
      tx.pure.u64(coverage),
      prem,
    ],
  });
  // agentCut is intentionally NOT transferred to the agent here — escrowed for resolve.
  const res = await exec(tx, "hire", `hire ${agent.name}`);
  revenue.feesUsdc += Number(protocolCut) / 1e6;
  revenue.premiumsUsdc += Number(premium) / 1e6;
  return {
    digest: res.digest,
    policyId: created(res, "::insurance::Policy<"),
    owner: agent.owner,
    feeUsdc,
    protocolFeeUsdc: Number(protocolCut) / 1e6,
    premiumUsdc: Number(premium) / 1e6,
    coverageUsdc: Number(coverage) / 1e6,
    agentNetUsdc: Number(agentCut) / 1e6,
    reliabilityBps: agent.reliabilityBps,
  };
}

/** Faucet: mint mock USDC + send a little SUI (gas) to a user's connected wallet so they
 *  can sign & pay for hires themselves. Backend holds the mock-USDC treasury cap. */
export async function fundWallet(address: string, usdc = 100, sui = 0.1) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::mock_usdc::faucet`,
    arguments: [tx.object(d.stablecoin.treasuryCapId), tx.pure.u64(BigInt(Math.round(usdc * 1e6))), tx.pure.address(address)],
  });
  const [gas] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(Math.round(sui * 1e9)))]);
  tx.transferObjects([gas], tx.pure.address(address));
  const res = await exec(tx, "admin", `fund ${address.slice(0, 8)}…`);
  return { digest: res.digest, usdc, sui };
}

/** Record revenue for a hire the USER signed client-side (backend didn't collect it). */
export function recordHireRevenue(protocolFeeUsdc: number, premiumUsdc: number) {
  revenue.feesUsdc += protocolFeeUsdc || 0;
  revenue.premiumsUsdc += premiumUsdc || 0;
}

/** PTB #2: auditor settles the job. Settles the escrowed agent fee (PASS → agent;
 *  FAIL → refunded), plus the guarantee (coverage/slash) and reliability update. */
export async function resolve(
  agentId: string,
  policyId: string,
  verdictPass: boolean,
  blobId: string,
  newReliabilityBps: number,
  ownerAddr: string,
  agentNetUsdc: number,
  withGuarantee: boolean,
  hirerAddr: string = ME, // who paid (user wallet, or backend in custodial mode)
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::resolver::resolve`,
    typeArguments: [STABLE],
    arguments: [
      tx.object(policyId),
      tx.object(d.reservePoolId),
      tx.object(agentId),
      tx.object(d.auditor.agentId),
      tx.pure.bool(verdictPass),
      tx.pure.vector("u8", bytes(blobId)),
      tx.pure.u64(BigInt(newReliabilityBps)),
    ],
  });
  // Settle the escrowed agent fee.
  const escrow = BigInt(Math.round(agentNetUsdc * 1e6));
  if (escrow > 0n) {
    const usdc = tx.object(await pickUsdcCoin());
    const [feeCoin] = tx.splitCoins(usdc, [tx.pure.u64(escrow)]);
    if (verdictPass) {
      tx.transferObjects([feeCoin], tx.pure.address(ownerAddr)); // PASS: agent earns the fee
    } else if (withGuarantee) {
      // FAIL + guarantee: user is refunded via the policy's coverage payout from the
      // reserve; the escrowed fee funds that reserve so protocol capital isn't spent.
      tx.moveCall({ target: `${PKG}::insurance::deposit`, typeArguments: [STABLE], arguments: [tx.object(d.reservePoolId), feeCoin] });
    } else {
      tx.transferObjects([feeCoin], tx.pure.address(hirerAddr)); // FAIL, no guarantee: refund the hirer
    }
  }
  const res = await exec(tx, "resolve", "settle job");
  const ev: any = (res.events || []).find((e: any) => e.type.endsWith("::resolver::Resolved"));
  const payoutUsdc = ev ? num(ev.parsedJson.payout) / 1e6 : 0;
  const slashedUsdc = ev ? num(ev.parsedJson.slashed) / 1e6 : 0;
  revenue.payoutsUsdc += payoutUsdc; // claims out of the reserve
  revenue.slashedUsdc += slashedUsdc; // recovered from the agent's bond
  return { digest: res.digest, payoutUsdc, slashedUsdc, newReliabilityBps };
}

/** YES price = the agent's real performance: a Beta-smoothed pass-rate over its actual
 *  on-chain job history. Starts at a 90% prior (9 wins / 1 loss) and converges to the
 *  true success rate — every PASS raises it, every FAIL lowers it. Performance, not a
 *  made-up delta, drives the price. */
export function performanceReliability(jobsBefore: number, failsBefore: number, pass: boolean): number {
  const total = jobsBefore + 1;
  const fails = failsBefore + (pass ? 0 : 1);
  const successes = total - fails;
  const rel = (successes + 9) / (total + 10); // Beta(9,1) prior
  return Math.max(200, Math.min(9900, Math.round(rel * 10000)));
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Re-quote the pool's standing liquidity centered on `mid` (cancel + replace). Real
 *  DeepBook order placement; sustainable (no depletion, inventory returns on cancel). */
async function quoteAround(t: any, mid: number) {
  const m = Math.max(0.05, Math.min(0.95, mid));
  const tx = new Transaction();
  addCancelAllOrders(tx, t.poolId, t.yesType, STABLE, d.balanceManagerId);
  for (const o of [
    { price: +(m + 0.01).toFixed(3), quantity: 10, isBid: false },
    { price: +(m + 0.03).toFixed(3), quantity: 10, isBid: false },
    { price: +Math.max(0.01, m - 0.01).toFixed(3), quantity: 10, isBid: true },
    { price: +Math.max(0.01, m - 0.03).toFixed(3), quantity: 10, isBid: true },
  ])
    addLimitOrder(tx, t.poolId, t.yesType, STABLE, d.balanceManagerId, o);
  await exec(tx, "reprice", `re-quote @ ${m.toFixed(2)}`);
  return await readMidPrice(client, ME, t.poolId, t.yesType, STABLE);
}

/** A user trade: places a REAL DeepBook limit order at the trader's chosen price & size.
 *  It rests on the book (maker) or crosses existing quotes (taker) — genuine order entry
 *  on top of the protocol's performance-anchored liquidity. */
export async function tradeOnPool(taskClass: string, side: "buy" | "sell", price: number, size: number) {
  const t = poolEntry(taskClass);
  if (!t?.poolId || !d.balanceManagerId) throw new Error("no pool for this market");
  const tx = new Transaction();
  addLimitOrder(tx, t.poolId, t.yesType, STABLE, d.balanceManagerId, { price, quantity: size, isBid: side === "buy" });
  await exec(tx, "trade", `${side} ${size} YES @ ${price}`);
  const book = await readLevel2(client, ME, t.poolId, t.yesType, STABLE, 10);
  const mid = midFrom(book, await readMidPrice(client, ME, t.poolId, t.yesType, STABLE));
  return { mid, book, poolId: t.poolId };
}

/** Refuel a pool's balance manager (mint YES + deposit YES & USDC) and reset to a clean
 *  two-sided book, so user limit orders don't hit inventory limits / one-sided sweeps. */
export async function refuel(taskClass: string, usdc = 150) {
  const t = poolEntry(taskClass);
  if (!t?.poolId || !d.balanceManagerId) return null;
  const tx = new Transaction();
  const u = tx.object(await pickUsdcCoin());
  const [forMint] = tx.splitCoins(u, [tx.pure.u64(BigInt(Math.round(usdc * 1e6)))]);
  const minted = tx.moveCall({ target: `${PKG}::market::mint_set`, typeArguments: [STABLE, t.yesType, t.noType], arguments: [tx.object(t.marketId), forMint] });
  addDeposit(tx, d.balanceManagerId, t.yesType, minted[0]);
  const [forQuote] = tx.splitCoins(u, [tx.pure.u64(BigInt(Math.round(usdc * 1e6)))]);
  addDeposit(tx, d.balanceManagerId, STABLE, forQuote);
  tx.transferObjects([minted[1]], tx.pure.address(ME)); // NO side back to us
  await exec(tx, "admin", "refuel liquidity");
  const cur = (await readMidPrice(client, ME, t.poolId, t.yesType, STABLE)) ?? 0.9;
  return await quoteAround(t, cur);
}

/** Robust mid: use mid_price, else average best bid/ask, else whichever side exists. */
function midFrom(book: { bids: { price: number }[]; asks: { price: number }[] }, raw: number | null) {
  if (raw != null && raw > 0) return raw;
  const bb = book.bids[0]?.price;
  const ba = book.asks[0]?.price;
  if (bb && ba) return (bb + ba) / 2;
  return bb ?? ba ?? null;
}

/** Market-maker re-quote after a verdict: re-center the book on the new (performance-
 *  derived) reliability, so the live mid tracks the outcome. No-op if no pool. */
export async function repricePool(taskClass: string, newReliabilityBps: number) {
  const t = poolEntry(taskClass);
  if (!t?.poolId || !d.balanceManagerId) return null;
  return await quoteAround(t, newReliabilityBps / 10000);
}

/** Order book + mid for a task-class market: real DeepBook when a pool exists, else
 *  synthetic depth derived from the on-chain reliability. */
export async function marketView(taskClass: string) {
  const t = poolEntry(taskClass);
  if (t?.poolId) {
    try {
      const book = await readLevel2(client, ME, t.poolId, t.yesType, STABLE, 10);
      const mid = midFrom(book, await readMidPrice(client, ME, t.poolId, t.yesType, STABLE));
      if (mid != null && mid > 0)
        return { source: "deepbook", poolId: t.poolId, reliabilityBps: Math.round(mid * 10000), book };
    } catch {
      /* fall through to synthetic */
    }
  }
  const r = 0.9;
  const bids = [];
  const asks = [];
  for (let i = 1; i <= 5; i++) {
    bids.push({ price: r2(Math.max(0.01, r - i * 0.012)), size: 40 + i * 35 });
    asks.push({ price: r2(Math.min(0.99, r + i * 0.012)), size: 30 + i * 28 });
  }
  return { source: "synthetic", poolId: null as string | null, reliabilityBps: 9000, book: { bids, asks } };
}
