// Worker + auditor logic for 3 GENUINE crypto task-classes. The agent does work you
// can't trivially do (fetch + interpret real on-chain code, search routes); the auditor
// independently re-derives the objective ground truth (re-reads the chain / recomputes).
//
//   move-audit  : surface publicly-callable privileged functions lacking capability gating
//   coin-safety : can this coin be frozen / publicly minted?  (reads the defining package)
//   route       : pick the swap route with the best output across candidate pools
import { hasLLM } from "./config.js";
import { workerComplete } from "./anthropic.js";
import { fetchFunctionSummary, riskyFunctions, coinFlags, packageOf, walletSnapshot, tokenFacts, type FnSummary } from "./onchain.js";

export type TaskClass = "move-audit" | "coin-safety" | "route" | "general" | "wallet-report" | "token-brief" | "defi-health";

const JUDGE = { provider: "groq", model: "llama-3.3-70b-versatile" }; // independent auditor model
export interface ModelCfg { provider: string; model: string }
export interface WorkerResult { result: any; trace: string; mode: string }
export interface Verdict { pass: boolean; reason: string; recomputed: any }

export const TASK_META: Record<TaskClass, { label: string; agent: string; blurb: string; does: string; how: string; inputHint: string; examples: string[] }> = {
  "move-audit": {
    label: "Move Package Audit",
    agent: "MovePackageAuditor",
    blurb: "Scans a deployed Sui package for risky publicly-callable functions.",
    does: "Fetches every module of a live Sui package and flags privileged functions (mint, burn, withdraw, upgrade…) that are publicly callable with NO capability gating — the attack surface you'd otherwise have to read the whole package to find.",
    how: "The independent auditor re-fetches the same modules on-chain and re-derives the risky-function list; the agent passes only if its list matches exactly.",
    inputHint: "A Sui mainnet package address — e.g. “audit 0x…” or paste the 0x… address",
    examples: ["audit package 0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270", "is 0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7 safe?"],
  },
  "coin-safety": {
    label: "Coin Safety Check",
    agent: "CoinSafetyChecker",
    blurb: "Checks whether a coin can be frozen or freely minted.",
    does: "Reads a coin's defining package on-chain and reports two risks: can the issuer freeze your balance (a DenyCap / deny-list), and can new supply be minted without a treasury cap (inflation risk).",
    how: "The auditor independently re-reads the coin's package on-chain and recomputes the freeze/mint flags; the agent passes only if they match.",
    inputHint: "Ask plainly (“is DEEP safe?”) or paste any mainnet coin type / package address",
    examples: ["is DEEP safe to hold?", "check USDC", "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"],
  },
  route: {
    label: "Swap Route Optimizer",
    agent: "RouteOptimizer",
    blurb: "Finds the best-output route across candidate AMM pools.",
    does: "Given several AMM pools, computes the fee-adjusted output for each and returns the pool that gives the most tokens out — the routing you'd otherwise compute by hand across every venue.",
    how: "The auditor recomputes every pool's constant-product output and checks the agent picked the true best route at the correct amount.",
    inputHint: "Pools JSON (tokenIn, amountIn, pools[]) — click an example to start",
    examples: [],
  },
  general: {
    label: "General Analyst",
    agent: "GeneralBot",
    blurb: "Open-ended Q&A / analysis, answer graded by an independent auditor.",
    does: "A general-purpose AI analyst — ask anything, like a normal gen-AI assistant. Useful when there's no fixed format, just a question that needs a good answer.",
    how: "There's no on-chain ground truth here, so a separate, stronger auditor model independently judges whether the answer is correct and flags errors. Best-effort verification (a model's judgment), not a proof — for objectively-checkable tasks (math, on-chain facts) prefer the deterministic agents.",
    inputHint: "Ask anything — e.g. “Explain how a constant-product AMM sets price.”",
    examples: ["What is the capital of Australia?", "Explain how a constant-product AMM prices a swap.", "What are 3 risks of granting an unlimited token approval?"],
  },
  "wallet-report": {
    label: "Wallet / Portfolio Report",
    agent: "WalletReporter",
    blurb: "Reads a wallet on-chain and writes a holdings + activity report.",
    does: "Given a Sui address, reads its coin balances and owned objects on-chain and produces a readable portfolio report — holdings, number of object positions, and notes — the kind of summary you'd otherwise compile by hand from an explorer.",
    how: "Provable: the auditor re-reads the same wallet on-chain and confirms every balance and count in the report matches real chain state. The AI only writes the prose; the figures are certified.",
    inputHint: "A Sui wallet address — paste 0x…",
    examples: [],
  },
  "token-brief": {
    label: "Token Research Brief",
    agent: "TokenAnalyst",
    blurb: "Token brief: on-chain facts verified, thesis graded.",
    does: "Produces a research brief on a token — verified on-chain facts (symbol, decimals, total supply, freeze/mint authority) plus a short analyst thesis (use-case, risks, catalysts).",
    how: "Mixed tier: the facts are re-read on-chain and must match exactly (provable); the thesis is graded by an independent stronger model (best-effort, not a proof).",
    inputHint: "A coin (“DEEP”) or a full coin type 0x…::module::SYMBOL",
    examples: ["DEEP", "research SUI"],
  },
  "defi-health": {
    label: "DeFi Position Health",
    agent: "DeFiHealthChecker",
    blurb: "Computes a lending position's health factor & liquidation buffer.",
    does: "Given a lending position (collateral, debt, liquidation threshold), computes the health factor and how far the collateral can fall before liquidation.",
    how: "Provable: the auditor recomputes the health factor and liquidation buffer from the same inputs and checks the agent's numbers.",
    inputHint: "Position JSON {collateralUsd, debtUsd, liquidationThreshold} — click an example",
    examples: [],
  },
};

// Name shortcuts for common MAINNET coins. ANY other coin works too — just paste its
// full type (0x…::module::SYMBOL) or package address; we read its package on-chain.
const SYMBOLS: Record<string, string> = {
  deep: "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
  sui: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  usdc: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
};

/** Fast, deterministic extraction. Returns the structured input or null if not found. */
function parseDeterministic(taskClass: TaskClass, text: string): string | null {
  if (taskClass === "move-audit") {
    return text.match(/0x[0-9a-fA-F]{40,64}/)?.[0] ?? null;
  }
  if (taskClass === "coin-safety") {
    const full = text.match(/0x[0-9a-fA-F]+::\w+::\w+/);
    if (full) return full[0];
    const lower = ` ${text.toLowerCase()} `;
    for (const sym of Object.keys(SYMBOLS)) if (new RegExp(`[\\s$]${sym}\\b`).test(lower)) return SYMBOLS[sym];
    // accept a bare package address too — coinFlags only needs the defining package
    const addr = text.match(/0x[0-9a-fA-F]{40,64}/);
    if (addr) return addr[0];
    return null;
  }
  if (taskClass === "general") {
    return text.length ? text : null; // any non-empty prompt
  }
  if (taskClass === "wallet-report") {
    return text.match(/0x[0-9a-fA-F]{40,64}/)?.[0] ?? null; // a Sui address
  }
  if (taskClass === "token-brief") {
    const full = text.match(/0x[0-9a-fA-F]+::\w+::\w+/);
    if (full) return full[0];
    const lower = ` ${text.toLowerCase()} `;
    for (const sym of Object.keys(SYMBOLS)) if (new RegExp(`[\\s$]${sym}\\b`).test(lower)) return SYMBOLS[sym];
    return null;
  }
  if (taskClass === "defi-health") {
    try {
      const p = JSON.parse(text);
      if (["collateralUsd", "debtUsd", "liquidationThreshold"].every((k) => typeof p[k] === "number")) return JSON.stringify(p);
    } catch { /* not json */ }
    return null;
  }
  try {
    const p = JSON.parse(text);
    if (Array.isArray(p.pools) && p.pools.length) return JSON.stringify(p);
  } catch {
    /* not json */
  }
  return null;
}

const PARSE_HELP: Record<TaskClass, string> = {
  "move-audit": 'Tell me which package to audit — say "audit 0x…" or paste a Sui package address.',
  "coin-safety": 'On mainnet I can check DEEP, SUI or USDC — try "is DEEP safe?" — or paste any coin type (0x…::module::SYMBOL) / package address.',
  route: "Route needs pools JSON — click an example below to start, then edit the numbers.",
  general: "Type a question or prompt for the analyst.",
  "wallet-report": "Paste a Sui wallet address (0x…) to report on.",
  "token-brief": 'Name a coin ("DEEP") or paste a full coin type 0x…::module::SYMBOL.',
  "defi-health": "Position needs JSON {collateralUsd, debtUsd, liquidationThreshold} — click an example.",
};

/** Use the LLM to interpret fuzzy phrasing, then re-validate through parseDeterministic. */
async function llmExtract(taskClass: TaskClass, text: string): Promise<string | null> {
  const system =
    taskClass === "move-audit"
      ? 'Extract the Sui package address the user wants audited. Reply ONLY JSON {"value":"0x..."} (empty string if none).'
      : `Map the user's coin to an on-chain (mainnet) type. Known: DEEP=${SYMBOLS.deep}, SUI=${SYMBOLS.sui}, USDC=${SYMBOLS.usdc}. If they pasted a full 0x...::module::SYMBOL, return that. If it's a coin you have NO exact type for, return an empty string — do NOT guess a different coin. Reply ONLY JSON {"value":"<coin type or empty>"}.`;
  const { json } = await workerComplete(system, text);
  const v = String(json?.value || "").trim();
  return v ? parseDeterministic(taskClass, v) ?? (/0x[0-9a-fA-F]+/.test(v) ? v : null) : null;
}

/** Strict deterministic normalize used by the run itself (no guessing). */
export function normalizeStrict(taskClass: TaskClass, raw: string): string {
  const det = parseDeterministic(taskClass, (raw || "").trim());
  if (!det) throw new Error(PARSE_HELP[taskClass]);
  return det;
}

function describe(taskClass: TaskClass, input: string): string {
  if (taskClass === "coin-safety") {
    const sym = Object.entries(SYMBOLS).find(([, t]) => t === input)?.[0];
    return sym ? `${sym.toUpperCase()} (${input.slice(0, 16)}…)` : `${input.slice(0, 22)}…`;
  }
  if (taskClass === "move-audit") return `package ${input.slice(0, 18)}…`;
  return "those pools";
}

/** Resolve free text to a target. exact = run now; suggest = ask the user to confirm
 *  the LLM's interpretation first; none = couldn't understand it. */
export async function resolveInput(
  taskClass: TaskClass,
  raw: string,
): Promise<{ status: "exact" | "suggest" | "none"; input?: string; label?: string; help?: string }> {
  const text = (raw || "").trim();
  const det = parseDeterministic(taskClass, text);
  if (det) return { status: "exact", input: det };
  if ((taskClass === "move-audit" || taskClass === "coin-safety") && hasLLM) {
    try {
      const v = await llmExtract(taskClass, text);
      if (v) return { status: "suggest", input: v, label: describe(taskClass, v) };
    } catch {
      /* fall through */
    }
  }
  return { status: "none", help: PARSE_HELP[taskClass] };
}

const fnSummaryText = (fns: FnSummary[]) =>
  fns.map((f) => `${f.module}::${f.name} [${f.visibility}${f.isEntry ? ",entry" : ""}] (${f.params.join(", ")})`).join("\n");

function defiHealthGroundTruth(i: any) {
  const c = Number(i.collateralUsd), d = Number(i.debtUsd), lt = Number(i.liquidationThreshold);
  const hf = d > 0 ? (c * lt) / d : Infinity;
  const drawdown = isFinite(hf) && hf > 0 ? Math.max(0, 1 - 1 / hf) * 100 : 100;
  return { healthFactor: isFinite(hf) ? Math.round(hf * 1000) / 1000 : 9999, maxDrawdownPct: Math.round(drawdown * 100) / 100 };
}

function routeGroundTruth(i: any) {
  const out = (i.pools || []).map((p: any) => {
    const inWithFee = i.amountIn * (10000 - p.feeBps) / 10000;
    return { dex: p.dex, amountOut: (p.reserveOut * inWithFee) / (p.reserveIn + inWithFee) };
  });
  const best = out.reduce((a: any, b: any) => (b.amountOut > a.amountOut ? b : a), out[0]);
  return { bestDex: best.dex, amountOut: Math.round(best.amountOut * 1e6) / 1e6, all: out };
}

// ---------------- worker ----------------
export async function runWorker(taskClass: TaskClass, input: string, cfg?: ModelCfg): Promise<WorkerResult> {
  const useLLM = cfg ? cfg.provider === "groq" || cfg.provider === "anthropic" : false;
  if (useLLM) {
    try { return { ...(await runWorkerLLM(taskClass, input, cfg)), mode: cfg!.model }; } catch { /* fall back */ }
  }
  return { ...(await runWorkerDeterministic(taskClass, input)), mode: "rule-engine" };
}

async function runWorkerLLM(taskClass: TaskClass, input: string, cfg?: ModelCfg): Promise<Omit<WorkerResult, "mode">> {
  if (taskClass === "move-audit") {
    const fns = await fetchFunctionSummary(input.trim());
    const { json, trace } = await workerComplete(
      'You are MovePackageAuditor. From the function list, return ONLY the publicly-callable privileged functions (names containing mint/burn/withdraw/upgrade/migrate/admin) that are NOT capability-gated (no parameter type containing "Cap"). Reply ONLY JSON {"risky":["module::function"]}.',
      fnSummaryText(fns), cfg,
    );
    return { result: json, trace };
  }
  if (taskClass === "coin-safety") {
    const fns = await fetchFunctionSummary(packageOf(input.trim()));
    const { json, trace } = await workerComplete(
      'You are CoinSafetyChecker. freezable = a DenyCap type appears in any function. publiclyMintable = a Public function named *mint* exists with no *Cap parameter. Reply ONLY JSON {"freezable":boolean,"publiclyMintable":boolean}.',
      fnSummaryText(fns), cfg,
    );
    return { result: json, trace };
  }
  if (taskClass === "general") {
    const { json, trace } = await workerComplete(
      'You are a precise AI analyst. Answer the user\'s question accurately and concisely. Reply ONLY JSON {"answer": string}.',
      input, cfg,
    );
    return { result: json, trace };
  }
  if (taskClass === "wallet-report") {
    // Facts come from a deterministic on-chain read; the model only writes the prose.
    const snap = await walletSnapshot(input.trim());
    const { json } = await workerComplete(
      'You are WalletReporter. Write a concise 1-2 sentence portfolio summary of this wallet snapshot (mention coin count and any notable holdings). Reply ONLY JSON {"summary": string}.',
      JSON.stringify(snap), cfg,
    );
    return { result: { ...snap, summary: json?.summary || "" }, trace: "on-chain wallet read + LLM summary" };
  }
  if (taskClass === "token-brief") {
    const facts = await tokenFacts(input.trim());
    const { json } = await workerComplete(
      'You are TokenAnalyst. Given these verified on-chain token facts, write a short research thesis. Reply ONLY JSON {"thesis":{"useCase":string,"risks":string,"catalysts":string}}.',
      JSON.stringify(facts), cfg,
    );
    return { result: { ...facts, thesis: json?.thesis || {} }, trace: "on-chain token facts + LLM thesis" };
  }
  if (taskClass === "defi-health") {
    const { json, trace } = await workerComplete(
      'You are DeFiHealthChecker. healthFactor = collateralUsd*liquidationThreshold/debtUsd. maxDrawdownPct = (1 - 1/healthFactor)*100. Reply ONLY JSON {"healthFactor":number,"maxDrawdownPct":number}.',
      input, cfg,
    );
    return { result: json, trace };
  }
  const { json, trace } = await workerComplete(
    'You are RouteOptimizer. For each pool: amountInWithFee = amountIn*(10000-feeBps)/10000; amountOut = reserveOut*amountInWithFee/(reserveIn+amountInWithFee). Return the pool (dex) with the highest amountOut. Reply ONLY JSON {"bestDex":string,"amountOut":number}.',
    input, cfg,
  );
  return { result: json, trace };
}

async function runWorkerDeterministic(taskClass: TaskClass, input: string): Promise<Omit<WorkerResult, "mode">> {
  if (taskClass === "move-audit") {
    const fns = await fetchFunctionSummary(input.trim());
    return { result: { risky: riskyFunctions(fns) }, trace: "rule engine: on-chain module scan" };
  }
  if (taskClass === "coin-safety") {
    const fns = await fetchFunctionSummary(packageOf(input.trim()));
    return { result: coinFlags(fns), trace: "rule engine: coin package scan" };
  }
  if (taskClass === "general") return { result: { answer: "(this agent needs an LLM worker configured)" }, trace: "no llm" };
  if (taskClass === "wallet-report") {
    const snap = await walletSnapshot(input.trim());
    return { result: { ...snap, summary: `${snap.coinTypes} coin type(s), ${snap.objects} object(s).` }, trace: "rule engine: wallet read" };
  }
  if (taskClass === "token-brief") {
    const facts = await tokenFacts(input.trim());
    return { result: { ...facts, thesis: {} }, trace: "rule engine: token facts (no thesis without LLM)" };
  }
  if (taskClass === "defi-health") return { result: defiHealthGroundTruth(JSON.parse(input)), trace: "rule engine: health factor" };
  const gt = routeGroundTruth(JSON.parse(input));
  return { result: { bestDex: gt.bestDex, amountOut: gt.amountOut }, trace: "rule engine: route search" };
}

// ---------------- auditor (objective, re-derived from chain / recomputed) ----------------
export async function runAuditor(taskClass: TaskClass, input: string, worker: any): Promise<Verdict> {
  if (taskClass === "general") {
    // No on-chain ground truth — an independent, stronger model judges the answer.
    const { json } = await workerComplete(
      'You are a strict independent auditor. Decide if the Answer correctly and accurately answers the Question. Penalize factual or arithmetic errors. Reply ONLY JSON {"correct":boolean,"reason":string}.',
      `Question:\n${input}\n\nAnswer:\n${worker?.answer ?? ""}`,
      JUDGE,
    );
    return { pass: !!json?.correct, reason: json?.reason || "auditor judgment", recomputed: { judge: JUDGE.model } };
  }
  if (taskClass === "move-audit") {
    const truth = riskyFunctions(await fetchFunctionSummary(input.trim())).sort();
    const claimed = [...new Set((worker?.risky || []).map(String))].sort() as string[];
    const ok = truth.length === claimed.length && truth.every((t, i) => t === claimed[i]);
    return ok
      ? { pass: true, reason: `Correctly surfaced ${truth.length} ungated privileged function(s).`, recomputed: { risky: truth } }
      : { pass: false, reason: `Risk list wrong. On-chain truth: [${truth.join(", ") || "none"}]. Agent: [${claimed.join(", ") || "none"}].`, recomputed: { risky: truth } };
  }
  if (taskClass === "coin-safety") {
    const truth = coinFlags(await fetchFunctionSummary(packageOf(input.trim())));
    const ok = !!worker?.freezable === truth.freezable && !!worker?.publiclyMintable === truth.publiclyMintable;
    return ok
      ? { pass: true, reason: `Correct: freezable=${truth.freezable}, publiclyMintable=${truth.publiclyMintable}.`, recomputed: truth }
      : { pass: false, reason: `Wrong flags. On-chain truth ${JSON.stringify(truth)}, agent ${JSON.stringify({ freezable: !!worker?.freezable, publiclyMintable: !!worker?.publiclyMintable })}.`, recomputed: truth };
  }
  if (taskClass === "wallet-report") {
    const truth = await walletSnapshot(input.trim());
    const key = (c: any[]) => c.map((x) => `${x.coinType}=${x.balance}`).sort().join("|");
    const ok = worker?.coinTypes === truth.coinTypes && key(worker?.coins || []) === key(truth.coins) && worker?.objects === truth.objects;
    return ok
      ? { pass: true, reason: `Verified on-chain: ${truth.coinTypes} coin type(s), ${truth.objects} object(s) — all balances match.`, recomputed: truth }
      : { pass: false, reason: `Report doesn't match chain. On-chain: ${truth.coinTypes} coins / ${truth.objects} objects.`, recomputed: truth };
  }
  if (taskClass === "token-brief") {
    const truth = await tokenFacts(input.trim());
    const factsOk = worker?.decimals === truth.decimals && String(worker?.supply) === String(truth.supply)
      && !!worker?.freezable === truth.freezable && !!worker?.publiclyMintable === truth.publiclyMintable;
    if (!factsOk) return { pass: false, reason: `On-chain facts wrong. Truth: ${JSON.stringify(truth)}.`, recomputed: truth };
    const t = worker?.thesis || {};
    const { json } = await workerComplete(
      'You are a strict editor. Given verified token facts and an analyst thesis, decide if the thesis is coherent, on-topic, and non-empty. Reply ONLY JSON {"ok":boolean,"reason":string}.',
      `Facts: ${JSON.stringify(truth)}\nThesis: ${JSON.stringify(t)}`, JUDGE,
    );
    return json?.ok
      ? { pass: true, reason: `Facts verified on-chain; thesis accepted. ${json?.reason || ""}`.trim(), recomputed: truth }
      : { pass: false, reason: `Facts verified, but thesis rejected: ${json?.reason || "weak/empty"}.`, recomputed: truth };
  }
  if (taskClass === "defi-health") {
    const gt = defiHealthGroundTruth(JSON.parse(input));
    const near = (a: number, b: number) => b === 0 ? a === 0 : Math.abs(a - b) / Math.abs(b) < 0.01;
    const ok = near(Number(worker?.healthFactor), gt.healthFactor) && near(Number(worker?.maxDrawdownPct), gt.maxDrawdownPct);
    return ok
      ? { pass: true, reason: `Correct: health factor ${gt.healthFactor}, liquidation buffer ${gt.maxDrawdownPct}%.`, recomputed: gt }
      : { pass: false, reason: `Wrong math. Truth: HF ${gt.healthFactor}, buffer ${gt.maxDrawdownPct}%; agent: HF ${worker?.healthFactor}, buffer ${worker?.maxDrawdownPct}%.`, recomputed: gt };
  }
  const gt = routeGroundTruth(JSON.parse(input));
  const ok = worker?.bestDex === gt.bestDex && Math.abs(Number(worker?.amountOut) - gt.amountOut) / gt.amountOut < 0.01;
  return ok
    ? { pass: true, reason: `Best route correct: ${gt.bestDex} → ${gt.amountOut}.`, recomputed: gt }
    : { pass: false, reason: `Wrong route. Best is ${gt.bestDex} (${gt.amountOut}); agent said ${worker?.bestDex} (${worker?.amountOut}).`, recomputed: gt };
}

// ---------------- demo samples (real MAINNET addresses) ----------------
const DEEP_PKG = "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270";
const USDC_PKG = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7";
const DEEP_TYPE = `${DEEP_PKG}::deep::DEEP`;
const USDC_TYPE = `${USDC_PKG}::usdc::USDC`;
const SAMPLE_WALLET = "0x1e63fee8516e1fa26016e97cc280beebb3def8e837a19be90a2504309a33aa64";
export const SAMPLES: Record<TaskClass, { clean: string; tricky: string }> = {
  "move-audit": {
    clean: DEEP_PKG, // mainnet DEEP token package
    tricky: USDC_PKG, // mainnet native USDC package (regulated coin)
  },
  "coin-safety": {
    clean: DEEP_TYPE, // mainnet DEEP — not freezable, not publicly mintable
    tricky: USDC_TYPE, // mainnet native USDC — regulated (deny-list) → weak models may call it safe
  },
  route: {
    clean: JSON.stringify({ tokenIn: "SUI", tokenOut: "USDC", amountIn: 1000, pools: [
      { dex: "BigPool", reserveIn: 1000000, reserveOut: 510000, feeBps: 300 },
      { dex: "LeanPool", reserveIn: 1000000, reserveOut: 500000, feeBps: 5 },
    ] }, null, 2),
    // simple-looking pools where the AI worker tends to misquote the exact output (FAIL)
    tricky: JSON.stringify({ tokenIn: "SUI", tokenOut: "USDC", amountIn: 1000, pools: [
      { dex: "Cetus", reserveIn: 1000000, reserveOut: 520000, feeBps: 30 },
      { dex: "Turbos", reserveIn: 1000000, reserveOut: 480000, feeBps: 30 },
    ] }, null, 2),
  },
  general: {
    clean: "What is the capital of Australia?",
    tricky: "What are three risks of granting an unlimited token approval to a smart contract?",
  },
  "wallet-report": {
    clean: SAMPLE_WALLET, // active mainnet wallet
    tricky: SAMPLE_WALLET,
  },
  "token-brief": {
    clean: DEEP_TYPE,
    tricky: USDC_TYPE,
  },
  "defi-health": {
    clean: JSON.stringify({ collateralUsd: 1000, debtUsd: 400, liquidationThreshold: 0.8 }, null, 2),
    tricky: JSON.stringify({ collateralUsd: 1500, debtUsd: 1100, liquidationThreshold: 0.85 }, null, 2),
  },
};
