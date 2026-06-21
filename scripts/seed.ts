// Seeds the deployed Vouch package on testnet:
//   - mints mock USDC to the admin/wallet
//   - creates the insurance ReservePool + seeds it
//   - registers 3 worker agents + the auditor
//   - creates the 3 task-class markets (placeholder DeepBook pool id for now)
// Updates deployments/testnet.json in place with the new object ids.
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_PATH = join(__dirname, "..", "deployments", "testnet.json");
const d = JSON.parse(readFileSync(DEPLOY_PATH, "utf8"));

const USDC = (n: number) => BigInt(Math.round(n * 1e6)); // 6 decimals
const PKG = d.packageId as string;
const STABLE = d.stablecoin.type as string;

const kp = Ed25519Keypair.deriveKeypair(process.env.SUI_MNEMONIC!.trim());
const me = kp.toSuiAddress();
const client = new SuiClient({ url: process.env.SUI_RPC || getFullnodeUrl("testnet") });

async function run(tx: Transaction, label: string) {
  tx.setGasBudget(200_000_000);
  const res = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showObjectChanges: true, showEffects: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  const status = res.effects?.status?.status;
  if (status !== "success") throw new Error(`${label} failed: ${JSON.stringify(res.effects?.status)}`);
  console.log(`  ✓ ${label}  (${res.digest})`);
  return res;
}

const created = (res: any, typeIncludes: string) =>
  (res.objectChanges || []).filter((c: any) => c.type === "created" && c.objectType?.includes(typeIncludes));

const taskClassOf = async (id: string) => {
  const o = await client.getObject({ id, options: { showContent: true } });
  const f = (o.data?.content as any)?.fields;
  const arr: number[] = f?.task_class ?? [];
  return { tc: String.fromCharCode(...arr), isAuditor: !!f?.is_auditor };
};

const AGENTS = [
  { tc: "clause", name: "ContractClauseBot", rel: 9200 },
  { tc: "invoice", name: "InvoiceCheckBot", rel: 9650 },
  { tc: "citation", name: "CitationCheckBot", rel: 8800 },
];
const POOL_PLACEHOLDER = "0x0000000000000000000000000000000000000000000000000000000000000000";

async function main() {
  console.log("seeding as", me);

  // 1) mint mock USDC to self
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${PKG}::mock_usdc::faucet`,
      arguments: [tx.object(d.stablecoin.treasuryCapId), tx.pure.u64(USDC(100_000)), tx.pure.address(me)],
    });
    const res = await run(tx, "mint 100,000 mock USDC");
    const coin = created(res, "0x2::coin::Coin")[0];
    d.usdcCoinId = coin.objectId;
  }

  // 2) create reserve
  {
    const tx = new Transaction();
    tx.moveCall({ target: `${PKG}::insurance::create_reserve`, typeArguments: [STABLE], arguments: [] });
    const res = await run(tx, "create reserve pool");
    d.reservePoolId = created(res, "::insurance::ReservePool")[0].objectId;
  }

  // 3) deposit into reserve + register auditor + 3 agents (one PTB)
  {
    const tx = new Transaction();
    const usdc = tx.object(d.usdcCoinId);

    const [seed] = tx.splitCoins(usdc, [tx.pure.u64(USDC(500))]);
    tx.moveCall({ target: `${PKG}::insurance::deposit`, typeArguments: [STABLE], arguments: [tx.object(d.reservePoolId), seed] });

    const [aBond] = tx.splitCoins(usdc, [tx.pure.u64(USDC(5))]);
    tx.moveCall({
      target: `${PKG}::agent_registry::register_auditor`,
      typeArguments: [STABLE],
      arguments: [
        tx.object(d.adminCapId),
        tx.object(d.agentRegistryId),
        tx.pure.string("AuditorBot"),
        tx.pure.address(d.auditor.operator),
        aBond,
      ],
    });

    for (const a of AGENTS) {
      const [bond] = tx.splitCoins(usdc, [tx.pure.u64(USDC(10))]);
      tx.moveCall({
        target: `${PKG}::agent_registry::register_agent`,
        typeArguments: [STABLE],
        arguments: [
          tx.object(d.agentRegistryId),
          tx.pure.string(a.name),
          tx.pure.vector("u8", Array.from(new TextEncoder().encode(a.tc))),
          bond,
          tx.pure.u64(a.rel),
        ],
      });
    }
    const res = await run(tx, "deposit + register auditor + 3 agents");

    for (const c of created(res, "::agent_registry::Agent<")) {
      const { tc, isAuditor } = await taskClassOf(c.objectId);
      if (isAuditor) d.auditor.agentId = c.objectId;
      else if (d.taskClasses[tc]) d.taskClasses[tc].agentId = c.objectId;
    }
  }

  // 4) create the 3 markets (one PTB)
  {
    const tx = new Transaction();
    for (const a of AGENTS) {
      const t = d.taskClasses[a.tc];
      tx.moveCall({
        target: `${PKG}::market::new_market`,
        typeArguments: [STABLE, t.yesType, t.noType],
        arguments: [
          tx.pure.vector("u8", Array.from(new TextEncoder().encode(a.tc))),
          tx.pure.address(POOL_PLACEHOLDER),
          tx.object(t.yesTreasuryCapId),
          tx.object(t.noTreasuryCapId),
        ],
      });
    }
    const res = await run(tx, "create 3 markets");
    for (const c of created(res, "::market::Market<")) {
      const { tc } = await taskClassOf(c.objectId);
      if (d.taskClasses[tc]) d.taskClasses[tc].marketId = c.objectId;
    }
  }

  writeFileSync(DEPLOY_PATH, JSON.stringify(d, null, 2) + "\n");
  console.log("\nupdated deployments/testnet.json:");
  console.log("  reserve   ", d.reservePoolId);
  console.log("  auditor   ", d.auditor.agentId);
  for (const a of AGENTS) console.log(`  ${a.tc.padEnd(9)} agent=${d.taskClasses[a.tc].agentId} market=${d.taskClasses[a.tc].marketId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
