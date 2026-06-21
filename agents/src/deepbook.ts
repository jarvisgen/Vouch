// Direct DeepBook v3 (testnet) integration via PTBs — no SDK (keeps us on @mysten/sui
// 1.45). Constants + Move signatures verified against @mysten/deepbook-v3 source.
//
// Our YES coin is the pool BASE, mock USDC the QUOTE (both 6 decimals). The YES
// mid-price ∈ [0,1] = implied success probability = the agent's live reliability.
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClient } from "@mysten/sui/client";

export const DEEPBOOK_PKG = "0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c";
export const DEEPBOOK_REGISTRY = "0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1";
export const DEEP_TYPE = "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP";
export const POOL_CREATION_FEE_DEEP = 500_000_000n; // 500 DEEP (6 dp)

const FLOAT = 1_000_000_000; // 1e9
const SCALAR = 1_000_000; // 1e6 (both base & quote are 6 dp)
const MAX_TS = 18446744073709551615n;

// price (0..1) and quantity (whole YES) -> on-chain u64 (base=quote=1e6 dp)
const encPrice = (p: number) => BigInt(Math.round((p * FLOAT * SCALAR) / SCALAR));
const encQty = (q: number) => BigInt(Math.round(q * SCALAR));
const decPrice = (raw: bigint) => Number(raw) / FLOAT; // both scalars equal -> /1e9
const decQty = (raw: bigint) => Number(raw) / SCALAR;

let clientOrderId = 1;

/** Create + share a BalanceManager (custody account for placing orders). */
export function addCreateBalanceManager(tx: Transaction) {
  const mgr = tx.moveCall({ target: `${DEEPBOOK_PKG}::balance_manager::new` });
  tx.moveCall({
    target: "0x2::transfer::public_share_object",
    typeArguments: [`${DEEPBOOK_PKG}::balance_manager::BalanceManager`],
    arguments: [mgr],
  });
}

/** Create a permissionless YES/USDC pool (pays the 500 DEEP fee from the wallet). */
export function addCreatePool(tx: Transaction, baseType: string, quoteType: string) {
  tx.moveCall({
    target: `${DEEPBOOK_PKG}::pool::create_permissionless_pool`,
    typeArguments: [baseType, quoteType],
    arguments: [
      tx.object(DEEPBOOK_REGISTRY),
      tx.pure.u64(encPrice(0.001)), // tick size 0.001
      tx.pure.u64(encQty(1)), // lot size 1 YES
      tx.pure.u64(encQty(1)), // min size 1 YES
      coinWithBalance({ type: DEEP_TYPE, balance: POOL_CREATION_FEE_DEEP }),
    ],
  });
}

/** Cancel all of the manager's resting orders on a pool (returns locked balances). */
export function addCancelAllOrders(tx: Transaction, poolId: string, baseType: string, quoteType: string, managerId: string) {
  const proof = tx.moveCall({
    target: `${DEEPBOOK_PKG}::balance_manager::generate_proof_as_owner`,
    arguments: [tx.object(managerId)],
  });
  tx.moveCall({
    target: `${DEEPBOOK_PKG}::pool::cancel_all_orders`,
    typeArguments: [baseType, quoteType],
    arguments: [tx.object(poolId), tx.object(managerId), proof, tx.object.clock()],
  });
}

export function addDeposit(tx: Transaction, managerId: string, coinType: string, coin: any) {
  tx.moveCall({
    target: `${DEEPBOOK_PKG}::balance_manager::deposit`,
    typeArguments: [coinType],
    arguments: [tx.object(managerId), coin],
  });
}

/** Place a maker limit order (fees paid in input coin, not DEEP). */
export function addLimitOrder(
  tx: Transaction,
  poolId: string,
  baseType: string,
  quoteType: string,
  managerId: string,
  o: { price: number; quantity: number; isBid: boolean },
) {
  const proof = tx.moveCall({
    target: `${DEEPBOOK_PKG}::balance_manager::generate_proof_as_owner`,
    arguments: [tx.object(managerId)],
  });
  tx.moveCall({
    target: `${DEEPBOOK_PKG}::pool::place_limit_order`,
    typeArguments: [baseType, quoteType],
    arguments: [
      tx.object(poolId),
      tx.object(managerId),
      proof,
      tx.pure.u64(clientOrderId++),
      tx.pure.u8(0), // NO_RESTRICTION
      tx.pure.u8(0), // SELF_MATCHING_ALLOWED
      tx.pure.u64(encPrice(o.price)),
      tx.pure.u64(encQty(o.quantity)),
      tx.pure.bool(o.isBid),
      tx.pure.bool(false), // payWithDeep = false
      tx.pure.u64(MAX_TS),
      tx.object.clock(),
    ],
  });
}

// ---------------- reads (devInspect, no gas) ----------------

async function inspect(client: SuiClient, sender: string, build: (tx: Transaction) => void) {
  const tx = new Transaction();
  tx.setSender(sender);
  build(tx);
  const r = await client.devInspectTransactionBlock({ sender, transactionBlock: tx });
  return r.results?.[0]?.returnValues ?? [];
}
const u64vec = (rv: any) => bcs.vector(bcs.u64()).parse(Uint8Array.from(rv[0])).map((x) => BigInt(x));

export async function readMidPrice(client: SuiClient, sender: string, poolId: string, baseType: string, quoteType: string) {
  const rv = await inspect(client, sender, (tx) =>
    tx.moveCall({ target: `${DEEPBOOK_PKG}::pool::mid_price`, typeArguments: [baseType, quoteType], arguments: [tx.object(poolId), tx.object.clock()] }),
  );
  if (!rv.length) return null;
  return decPrice(BigInt(bcs.u64().parse(Uint8Array.from(rv[0][0]))));
}

export async function readLevel2(
  client: SuiClient,
  sender: string,
  poolId: string,
  baseType: string,
  quoteType: string,
  ticks = 10,
) {
  const rv = await inspect(client, sender, (tx) =>
    tx.moveCall({
      target: `${DEEPBOOK_PKG}::pool::get_level2_ticks_from_mid`,
      typeArguments: [baseType, quoteType],
      arguments: [tx.object(poolId), tx.pure.u64(BigInt(ticks)), tx.object.clock()],
    }),
  );
  if (rv.length < 4) return { bids: [], asks: [] };
  const bidP = u64vec(rv[0]), bidQ = u64vec(rv[1]), askP = u64vec(rv[2]), askQ = u64vec(rv[3]);
  const zip = (p: bigint[], q: bigint[]) => p.map((price, i) => ({ price: decPrice(price), size: decQty(q[i] ?? 0n) }));
  return { bids: zip(bidP, bidQ), asks: zip(askP, askQ) };
}
