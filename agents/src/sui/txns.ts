// PTB builders. Two atomic transactions:
//   buildHireTx:   fee + premium in, create Policy, (read market price for premium)   [PTB #1]
//   buildResolveTx: auditor submits verdict + blobId; settle market+policy+bond        [PTB #2]
//
// TODO(step 4): build with @mysten/sui Transaction; merge/split USDC coins; call into
// vouch::insurance::buy_policy and vouch::resolver::resolve. Sign hire with the hirer
// keypair, resolve with the AUDITOR keypair.
import type { TaskClass } from "../types.js";

export interface HireParams {
  agentId: string;
  taskClass: TaskClass;
  feeUsdc: bigint;
  premiumUsdc: bigint;
  coverageUsdc: bigint;
  withGuarantee: boolean;
}

export function buildHireTx(_p: HireParams): unknown {
  throw new Error("TODO(step 4): PTB #1");
}

export interface ResolveParams {
  agentId: string;
  policyId: string;
  marketId: string;
  taskClass: TaskClass;
  pass: boolean;
  walrusBlobId: string;
}

export function buildResolveTx(_p: ResolveParams): unknown {
  throw new Error("TODO(step 4): PTB #2");
}
