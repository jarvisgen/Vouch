// Creates REAL DeepBook pools for the new agents (token-brief, wallet-report, defi-health)
// WITHOUT republishing: it repurposes the package's already-minted spare outcome coins
// (no_clause / no_invoice / no_citation) as each new pool's base, priced in USDC and seeded
// around that agent's on-chain reliability. 500 DEEP per pool.
//
// Run:  pnpm --filter @vouch/agents exec tsx src/make-market-extra.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { deployment as d } from "./config.js";
import { keypair, ME, client, leaderboard } from "./chain.js";
import { addCreatePool, addDeposit, addLimitOrder, DEEP_TYPE, POOL_CREATION_FEE_DEEP } from "./deepbook.js";

const DEPLOY_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deployments", "testnet.json");
const PKG = d.packageId as string;
const STABLE = d.stablecoin.type as string;
const SEED_USDC = 30_000_000n;

// new agent task-class -> source task-class whose spare NO coin we repurpose as the pool base
const MAP = [
  { tc: "token-brief", src: "clause" },
  { tc: "wallet-report", src: "invoice" },
  { tc: "defi-health", src: "citation" },
];

async function exec(tx: Transaction, label: string) {
  tx.setGasBudget(500_000_000);
  const res = await client.signAndExecuteTransaction({ signer: keypair, transaction: tx, options: { showObjectChanges: true, showEffects: true } });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status?.status !== "success") throw new Error(`${label}: ${JSON.stringify(res.effects?.status)}`);
  console.log(`  ✓ ${label} (${res.digest})`);
  return res;
}
const created = (res: any, t: string) => (res.objectChanges || []).find((c: any) => c.type === "created" && c.objectType?.includes(t))?.objectId;
const save = () => writeFileSync(DEPLOY_PATH, JSON.stringify(d, null, 2) + "\n");
async function deepBalance(): Promise<bigint> {
  const { data } = await client.getCoins({ owner: ME, coinType: DEEP_TYPE });
  return data.reduce((s, c) => s + BigInt(c.balance), 0n);
}

async function main() {
  if (!d.balanceManagerId) throw new Error("no balanceManagerId — run make-market first to create it");
  const mgr = d.balanceManagerId as string;
  const board = await leaderboard();
  const relOf = (tc: string) => { const a = board.find((x: any) => x.taskClass === tc); return a ? a.reliabilityBps / 10000 : 0.9; };

  let deep = await deepBalance();
  console.log(`wallet ${ME}\nDEEP balance: ${Number(deep) / 1e6} (need 500 per pool)`);

  for (const { tc, src } of MAP) {
    if ((d.taskClasses as any)[tc]?.poolId) { console.log(`${tc} already has a pool — skip`); continue; }
    if (deep < POOL_CREATION_FEE_DEEP) { console.log(`Stopping — DEEP exhausted (${Number(deep) / 1e6} left).`); break; }
    const s = (d.taskClasses as any)[src];
    const base = s.noType as string; // repurpose the spare NO coin as this pool's base

    // 1) create the pool: base = no_X, quote = USDC
    const c1 = new Transaction();
    addCreatePool(c1, base, STABLE);
    const r1 = await exec(c1, `create ${tc} pool (${base.split("::").pop()}/USDC)`);
    const poolId = created(r1, "::pool::Pool<");
    deep -= POOL_CREATION_FEE_DEEP;

    // 2) seed liquidity around the agent's reliability. mint_set uses the SOURCE market's
    //    real type order; we keep the NO side as our base inventory and return the YES side.
    const mid = Math.max(0.05, Math.min(0.95, relOf(tc)));
    const c2 = new Transaction();
    const minted = c2.moveCall({
      target: `${PKG}::market::mint_set`,
      typeArguments: [STABLE, s.yesType, s.noType],
      arguments: [c2.object(s.marketId), coinWithBalance({ type: STABLE, balance: SEED_USDC })],
    });
    addDeposit(c2, mgr, base, minted[1]); // NO side -> base inventory to sell
    addDeposit(c2, mgr, STABLE, coinWithBalance({ type: STABLE, balance: SEED_USDC })); // USDC to bid
    c2.transferObjects([minted[0]], c2.pure.address(ME)); // YES side back to us
    for (const o of [
      { price: +(mid + 0.01).toFixed(3), quantity: 10, isBid: false },
      { price: +(mid + 0.03).toFixed(3), quantity: 10, isBid: false },
      { price: +Math.max(0.01, mid - 0.01).toFixed(3), quantity: 10, isBid: true },
      { price: +Math.max(0.01, mid - 0.03).toFixed(3), quantity: 10, isBid: true },
    ])
      addLimitOrder(c2, poolId!, base, STABLE, mgr, o);
    await exec(c2, `seed ${tc} liquidity (mid ${mid.toFixed(2)})`);

    (d.taskClasses as any)[tc] = {
      poolId,
      yesType: base,            // base coin traded in this pool
      noType: s.yesType,        // the other side (only used by mint/refuel)
      marketId: s.marketId,     // source market for minting the base coin
      yesTreasuryCapId: s.noTreasuryCapId,
      noTreasuryCapId: s.yesTreasuryCapId,
    };
    save();
    console.log(`    pool ${poolId}  (reliability market for ${tc})`);
  }
  console.log("\ndone — deployments/testnet.json updated with new pools.");
}

main().catch((e) => { console.error(e); process.exit(1); });
