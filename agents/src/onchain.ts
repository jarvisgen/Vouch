// Read-only Sui chain access for the ANALYSIS layer (MovePackageAuditor, CoinSafetyChecker,
// TokenAnalyst, WalletReporter…). Agents fetch + interpret real on-chain code/state; the
// auditor independently re-fetches and re-checks. This reads MAINNET so users analyze real
// mainnet packages/coins/wallets. (Payments/settlement stay on testnet — see chain.ts.)
// Override with READ_RPC if needed.
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";

const client = new SuiClient({ url: process.env.READ_RPC || getFullnodeUrl("mainnet") });

export interface FnSummary {
  module: string;
  name: string;
  visibility: string;
  isEntry: boolean;
  params: string[];
}

function typeToString(t: any): string {
  if (typeof t === "string") return t;
  if (t.Struct) return `${t.Struct.address}::${t.Struct.module}::${t.Struct.name}`;
  if (t.Reference) return `&${typeToString(t.Reference)}`;
  if (t.MutableReference) return `&mut ${typeToString(t.MutableReference)}`;
  if (t.Vector) return `vector<${typeToString(t.Vector)}>`;
  if (t.TypeParameter !== undefined) return `T${t.TypeParameter}`;
  return JSON.stringify(t);
}

/** Fetch a summary of every exposed function in a package (real on-chain read). */
export async function fetchFunctionSummary(packageId: string): Promise<FnSummary[]> {
  const mods = await client.getNormalizedMoveModulesByPackage({ package: packageId });
  const out: FnSummary[] = [];
  for (const [modName, mod] of Object.entries<any>(mods)) {
    for (const [fnName, fn] of Object.entries<any>(mod.exposedFunctions)) {
      out.push({
        module: modName,
        name: fnName,
        visibility: fn.visibility,
        isEntry: !!fn.isEntry,
        params: (fn.parameters || []).map(typeToString),
      });
    }
  }
  return out;
}

const PRIV = /mint|burn|withdraw|upgrade|migrate|set_admin|set_owner|add_minter|drain|rescue/i;
const hasCap = (params: string[]) => params.some((p) => /Cap(<|>|$)|AdminCap|TreasuryCap|OwnerCap|DenyCap/.test(p));

/** GROUND TRUTH: a publicly-callable privileged function with no capability-gating param. */
export function riskyFunctions(fns: FnSummary[]) {
  return fns
    .filter((f) => f.visibility === "Public" && PRIV.test(f.name) && !hasCap(f.params))
    .map((f) => `${f.module}::${f.name}`);
}

/** GROUND TRUTH for a coin's defining package: can it be frozen / publicly minted? */
export function coinFlags(fns: FnSummary[]) {
  const usesDenyCap = fns.some((f) => f.params.some((p) => /DenyCap/.test(p)));
  const publicMint = fns.some((f) => f.visibility === "Public" && /mint/i.test(f.name) && !hasCap(f.params));
  return { freezable: usesDenyCap, publiclyMintable: publicMint };
}

export const packageOf = (coinType: string) => coinType.split("::")[0];

/** GROUND TRUTH for a wallet: its coin balances + owned-object count (real on-chain read).
 *  Deterministic & order-stable so the worker and auditor derive identical snapshots. */
export async function walletSnapshot(address: string) {
  const balances = await client.getAllBalances({ owner: address });
  const coins = balances
    .map((b) => ({ coinType: b.coinType, balance: b.totalBalance }))
    .sort((a, b) => (a.coinType < b.coinType ? -1 : 1));
  let objects = 0;
  let cursor: string | null | undefined = null;
  for (let page = 0; page < 3; page++) {
    const r: any = await client.getOwnedObjects({ owner: address, cursor: cursor ?? undefined, limit: 50 });
    objects += r.data.length;
    if (!r.hasNextPage) break;
    cursor = r.nextCursor;
  }
  return { coinTypes: coins.length, coins, objects };
}

/** GROUND TRUTH for a token: metadata + total supply + freeze/mint flags (real on-chain read). */
export async function tokenFacts(coinType: string) {
  const flags = coinFlags(await fetchFunctionSummary(packageOf(coinType)));
  let symbol: string | null = null;
  let decimals: number | null = null;
  let supply: string | null = null;
  try { const md = await client.getCoinMetadata({ coinType }); if (md) { symbol = md.symbol; decimals = md.decimals; } } catch { /* no metadata */ }
  try { supply = (await client.getTotalSupply({ coinType })).value; } catch { /* no supply */ }
  return { symbol, decimals, supply, freezable: flags.freezable, publiclyMintable: flags.publiclyMintable };
}
