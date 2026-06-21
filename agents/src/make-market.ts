// Creates real DeepBook YES/USDC pools for each task-class and seeds liquidity.
// Needs testnet DEEP (500 per pool) in the wallet — get it by swapping SUI->DEEP on
// FlowX testnet (https://testnet.flowx.finance) with the same Slush wallet.
//
// Run:  pnpm --filter @vouch/agents make-market         (all unseeded classes)
//       MARKETS=clause pnpm --filter @vouch/agents make-market   (just one)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { deployment as d } from "./config.js";
import { keypair, ME, client, readAgent } from "./chain.js";
import {
  addCreateBalanceManager,
  addCreatePool,
  addDeposit,
  addLimitOrder,
  DEEP_TYPE,
  POOL_CREATION_FEE_DEEP,
} from "./deepbook.js";
import type { TaskClass } from "./tasks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_PATH = join(__dirname, "..", "..", "deployments", "testnet.json");
const PKG = d.packageId as string;
const STABLE = d.stablecoin.type as string;
const SEED_USDC = 30_000_000n; // 30 USDC of YES minted + 30 USDC quote for bids

async function exec(tx: Transaction, label: string) {
  tx.setGasBudget(500_000_000);
  const res = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showObjectChanges: true, showEffects: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status?.status !== "success") throw new Error(`${label}: ${JSON.stringify(res.effects?.status)}`);
  console.log(`  ✓ ${label} (${res.digest})`);
  return res;
}
const created = (res: any, t: string) =>
  (res.objectChanges || []).find((c: any) => c.type === "created" && c.objectType?.includes(t))?.objectId;
const save = () => writeFileSync(DEPLOY_PATH, JSON.stringify(d, null, 2) + "\n");

async function deepBalance(): Promise<bigint> {
  const { data } = await client.getCoins({ owner: ME, coinType: DEEP_TYPE });
  return data.reduce((s, c) => s + BigInt(c.balance), 0n);
}

async function main() {
  const only = process.env.MARKETS?.split(",") as TaskClass[] | undefined;
  const classes = (["clause", "invoice", "citation"] as TaskClass[])
    .filter((c) => !d.taskClasses[c].poolId)
    .filter((c) => !only || only.includes(c));

  let deep = await deepBalance();
  console.log(`wallet ${ME}\nDEEP balance: ${Number(deep) / 1e6} (need 500 per pool)`);
  if (deep < POOL_CREATION_FEE_DEEP) {
    console.error(`\n✗ Not enough DEEP. Swap SUI→DEEP on https://testnet.flowx.finance (need ≥500), then re-run.`);
    process.exit(1);
  }

  // one shared BalanceManager for all pools
  if (!d.balanceManagerId) {
    const tx = new Transaction();
    addCreateBalanceManager(tx);
    const res = await exec(tx, "create BalanceManager");
    d.balanceManagerId = created(res, "::balance_manager::BalanceManager");
    save();
  }
  const mgr = d.balanceManagerId as string;

  for (const tc of classes) {
    if (deep < POOL_CREATION_FEE_DEEP) {
      console.log(`\nStopping — DEEP exhausted (${Number(deep) / 1e6} left). Re-run after topping up for: ${classes.slice(classes.indexOf(tc)).join(", ")}`);
      break;
    }
    const t = d.taskClasses[tc];

    // 1) create the pool
    const c1 = new Transaction();
    addCreatePool(c1, t.yesType, STABLE); // base=YES, quote=USDC
    const r1 = await exec(c1, `create ${tc} YES/USDC pool`);
    t.poolId = created(r1, "::pool::Pool<");
    save();
    deep -= POOL_CREATION_FEE_DEEP;

    // 2) seed liquidity around the agent's current reliability
    const mid = (await readAgent(tc)).reliabilityBps / 10000;
    const c2 = new Transaction();
    const minted = c2.moveCall({
      target: `${PKG}::market::mint_set`,
      typeArguments: [STABLE, t.yesType, t.noType],
      arguments: [c2.object(t.marketId), coinWithBalance({ type: STABLE, balance: SEED_USDC })],
    });
    const yes = minted[0];
    const no = minted[1];
    addDeposit(c2, mgr, t.yesType, yes); // YES inventory to sell
    addDeposit(c2, mgr, STABLE, coinWithBalance({ type: STABLE, balance: SEED_USDC })); // USDC to bid
    c2.transferObjects([no], c2.pure.address(ME));
    for (const o of [
      { price: +(mid + 0.01).toFixed(3), quantity: 10, isBid: false },
      { price: +(mid + 0.03).toFixed(3), quantity: 10, isBid: false },
      { price: +(mid - 0.01).toFixed(3), quantity: 10, isBid: true },
      { price: +(mid - 0.03).toFixed(3), quantity: 10, isBid: true },
    ])
      addLimitOrder(c2, t.poolId!, t.yesType, STABLE, mgr, o);
    await exec(c2, `seed ${tc} liquidity (mid ${mid})`);
    console.log(`    pool ${t.poolId}`);
  }

  save();
  console.log("\nupdated deployments/testnet.json with poolIds + balanceManagerId.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
