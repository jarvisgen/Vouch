// Vouch agent service. Drives the real end-to-end loop the UI calls:
//   hire (PTB #1) -> worker -> auditor -> Walrus -> resolve (PTB #2)
import express from "express";
import cors from "cors";
import { createHash } from "node:crypto";
import { env, deployment as d, hasLLM, llmProvider, llmModel } from "./config.js";
import { runWorker, runAuditor, normalizeStrict, resolveInput, SAMPLES, TASK_META, type TaskClass } from "./tasks.js";
import { putBundle, evidenceLink } from "./walrus.js";
import { hire, resolve, leaderboard, readAgentById, createAgent, performanceReliability, marketView, repricePool, tradeOnPool, refuel, getActivity, getRevenue, ME } from "./chain.js";
import { getConfig, setConfig, MODEL_CATALOG } from "./models.js";

// Only our own internal worker origin(s) may be called — no user-supplied URLs reach fetch().
// This blocks SSRF (cloud metadata / internal services) even for legacy endpoint configs.
const WORKER_ORIGINS = (process.env.VOUCH_WORKER_ORIGINS ?? "http://localhost:8787").split(",").map((s) => s.trim());
async function callExternalAgent(url: string, taskClass: string, input: string) {
  let origin: string;
  try { origin = new URL(url).origin; } catch { throw new Error("invalid worker url"); }
  if (!WORKER_ORIGINS.includes(origin)) throw new Error(`worker origin not allowlisted: ${origin}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskClass, input }), signal: ctrl.signal, redirect: "error" });
    if (!r.ok) throw new Error(`agent endpoint ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const text = (await r.text()).slice(0, 100_000); // cap response size
    const d: any = JSON.parse(text);
    return { result: d.result, trace: `internal worker @ ${origin}`, mode: d.mode || "external" };
  } finally { clearTimeout(timer); }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const explorer = (digest: string) => `https://suiscan.xyz/testnet/tx/${digest}`;

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    llm: hasLLM,
    provider: hasLLM ? llmProvider : "deterministic",
    model: hasLLM ? llmModel : null,
    wallet: ME,
    packageId: d.packageId,
    network: "testnet",
  }),
);

app.get("/api/agents", async (_req, res) => {
  try {
    const agents = await leaderboard();
    res.json(agents.map((a: any) => ({ ...a, config: getConfig(a.id) })));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Dogfood worker endpoint: lets us register our built-in agents as "external" endpoints
// so the import flow is genuinely real. Model picked via ?model=&provider= query.
app.post("/agent", async (req, res) => {
  const { taskClass, input } = req.body as { taskClass: TaskClass; input: string };
  const provider = (req.query.provider as string) || "groq";
  const model = (req.query.model as string) || "llama-3.1-8b-instant";
  try {
    const w = await runWorker(taskClass, input, { provider, model });
    res.json({ result: w.result, mode: w.mode });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/models", (_req, res) => res.json(MODEL_CATALOG));
app.get("/api/tasks", (_req, res) => res.json(TASK_META));
app.get("/api/revenue", (_req, res) => res.json(getRevenue()));
app.get("/api/activity", (_req, res) =>
  res.json(getActivity().map((a) => ({ ...a, tx: `https://suiscan.xyz/testnet/tx/${a.digest}` }))),
);

// One-time: refuel balance-manager inventory + reset clean books for all markets.
app.post("/api/admin/refuel", async (_req, res) => {
  try {
    const out: any = {};
    for (const tc of ["move-audit", "coin-safety", "route"]) out[tc] = await refuel(tc);
    res.json({ ok: true, mids: out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// A deliberately-flawed external agent (real, deterministic): a naive router that picks
// the biggest reserve and ignores fees — wrong on fee-traps. Demonstrates the auditor +
// insurance catching a bad agent, reproducibly.
app.post("/agent-naive", (req, res) => {
  const { taskClass, input } = req.body as { taskClass: string; input: string };
  if (taskClass !== "route") return res.status(400).json({ error: "naive agent only serves route" });
  const i = JSON.parse(input);
  const naive = (i.pools || []).reduce((a: any, b: any) => (b.reserveOut > a.reserveOut ? b : a), i.pools[0]);
  const out = (naive.reserveOut * i.amountIn) / (naive.reserveIn + i.amountIn); // ignores fee → wrong
  res.json({ result: { bestDex: naive.dex, amountOut: Math.round(out * 1e6) / 1e6 }, mode: "naive-rule" });
});

// Import / list an agent: register an on-chain identity + bond, and point Vouch at the
// agent's external endpoint (or a first-party model). The agent is built elsewhere.
app.post("/api/agents", async (req, res) => {
  const { name, taskClass, bondUsdc, endpoint, provider, model, feeUsdc } = req.body as {
    name: string;
    taskClass: string;
    bondUsdc: number;
    endpoint?: string;
    provider?: string;
    model?: string;
    feeUsdc?: number;
  };
  if (!name || !["move-audit", "coin-safety", "route", "general", "wallet-report", "token-brief", "defi-health"].includes(taskClass))
    return res.status(400).json({ error: "name + valid taskClass required" });
  if (!(bondUsdc >= 1)) return res.status(400).json({ error: "bondUsdc must be ≥ 1 (min stake)" });
  // SECURITY: arbitrary external endpoints are disabled — they are an SSRF vector. Agents are
  // hosted: Vouch runs a vetted first-party model. (Internal worker endpoints stay allowlisted.)
  if (endpoint) return res.status(400).json({ error: "external endpoints are disabled; create a hosted agent (provider + model)" });
  if (!provider || !model) return res.status(400).json({ error: "choose a hosted model (provider + model)" });
  const fee = feeUsdc && feeUsdc > 0 ? Number(feeUsdc) : 5;
  try {
    const { agentId, digest } = await createAgent(name, taskClass, bondUsdc);
    if (agentId) setConfig(agentId, { provider, model, feeUsdc: fee });
    res.json({ agentId, taskClass, tx: `https://suiscan.xyz/testnet/tx/${digest}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// Agent owner updates their task price.
app.post("/api/agents/:id/price", (req, res) => {
  const feeUsdc = Number((req.body as { feeUsdc: number }).feeUsdc);
  if (!(feeUsdc >= 1)) return res.status(400).json({ error: "feeUsdc must be ≥ 1" });
  setConfig(req.params.id, { ...getConfig(req.params.id), feeUsdc });
  res.json({ ok: true, feeUsdc });
});

app.get("/api/market/:taskClass", async (req, res) => {
  try {
    res.json(await marketView(req.params.taskClass as TaskClass));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Place a real limit order (price + size) on the agent's DeepBook pool.
app.post("/api/trade", async (req, res) => {
  const { taskClass, side, price, size } = req.body as { taskClass: string; side: "buy" | "sell"; price: number; size: number };
  if (!["buy", "sell"].includes(side)) return res.status(400).json({ error: "side must be buy|sell" });
  if (!(price > 0 && price < 1)) return res.status(400).json({ error: "price must be between 0 and 1 (YES probability)" });
  if (!(size > 0)) return res.status(400).json({ error: "size must be > 0" });
  try {
    res.json(await tradeOnPool(taskClass, side, Number(price), Math.min(Number(size), 20)));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/samples/:taskClass", (req, res) => {
  const tc = req.params.taskClass as TaskClass;
  res.json(SAMPLES[tc] ?? {});
});

// Resolve free text → target (exact runs now; suggest asks the user to confirm).
app.post("/api/resolve", async (req, res) => {
  const { taskClass, text } = req.body as { taskClass: TaskClass; text: string };
  try {
    res.json(await resolveInput(taskClass, text));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Streamed run: emits a terminal line per on-chain step (SSE), then a final result.
app.post("/api/run", async (req, res) => {
  const { agentId, input: rawInput, withGuarantee } = req.body as { agentId: string; input: string; withGuarantee: boolean };
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (o: any) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const log = (msg: string) => send({ type: "log", msg });

  try {
    if (!agentId || typeof rawInput !== "string") throw new Error("agentId + input required");
    const before = await readAgentById(agentId);
    if (!before) throw new Error("agent not found");
    const taskClass = before.taskClass as TaskClass;
    const cfg = getConfig(agentId);
    const fee = cfg.feeUsdc ?? 5;

    // 0) deterministic target (the UI already confirmed any fuzzy interpretation)
    const input = normalizeStrict(taskClass, rawInput);
    log(`PARSE target → ${input.slice(0, 64)}${input.length > 64 ? "…" : ""}`);

    // 1) hire (PTB #1)
    log(`HIRE  $${fee}: $${(fee * 0.1).toFixed(2)} platform fee, $${(fee * 0.9).toFixed(2)} fee ESCROWED (released to agent on PASS, refunded on FAIL)${withGuarantee ? `, + premium → reserve` : ""}`);
    const h = await hire(agentId, !!withGuarantee, fee);
    log(`  ✓ ${withGuarantee ? `guarantee ($${h.coverageUsdc} cover, $${h.premiumUsdc} premium)` : "no guarantee"} · escrow $${h.agentNetUsdc} held · tx ${h.digest.slice(0, 8)}…`);

    // 2) worker
    log(`WORK  ${cfg.endpoint ? "calling external agent endpoint" : "running worker " + (cfg.model ?? "")} on ${taskClass}…`);
    const worker = cfg.endpoint
      ? await callExternalAgent(cfg.endpoint, taskClass, input)
      : await runWorker(taskClass, input, cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : undefined);
    log(`  ✓ agent (${worker.mode}) returned: ${JSON.stringify(worker.result).slice(0, 80)}`);

    // 3) auditor
    log(`AUDIT independent auditor re-deriving ground truth from on-chain state…`);
    const verdict = await runAuditor(taskClass, input, worker.result);
    log(`  ${verdict.pass ? "✓ PASS" : "✗ FAIL"} — ${verdict.reason.slice(0, 90)}`);

    // 4) Walrus
    log(`WALRUS storing evidence bundle (input hash + output + verdict)…`);
    const bundle = { task: { taskClass, inputHash: sha256(input), input }, output: { mode: worker.mode, result: worker.result, trace: worker.trace }, verdict, createdAt: new Date().toISOString() };
    let blobId: string;
    let walrusOk = true;
    try { blobId = await putBundle(bundle); } catch { walrusOk = false; blobId = `sha256:${bundle.task.inputHash.slice(0, 32)}`; }
    log(`  ✓ blob ${blobId.slice(0, 16)}… ${walrusOk ? "(certified on Walrus)" : "(fallback hash)"}`);

    // 5) resolve (PTB #2)
    const newRel = performanceReliability(before.jobs, before.fails, verdict.pass);
    log(`RESOLVE auditor settling on-chain · ${verdict.pass ? "release fee to agent" : "REFUND user, agent gets nothing, slash bond"}…`);
    const r = await resolve(agentId, h.policyId, verdict.pass, blobId, newRel, before.owner, h.agentNetUsdc, !!withGuarantee);
    if (verdict.pass) log(`  ✓ fee $${h.agentNetUsdc} released to agent · premium $${h.premiumUsdc} kept · tx ${r.digest.slice(0, 8)}…`);
    else log(`  ✓ your $${h.agentNetUsdc} fee refunded · agent earned $0 · bond slashed $${r.slashedUsdc} · tx ${r.digest.slice(0, 8)}…`);
    const after = await readAgentById(agentId);
    log(`  reliability ${(before.reliabilityBps / 100).toFixed(0)}% → ${(newRel / 100).toFixed(0)}%`);

    // 6) reprice DeepBook
    log(`MARKET re-quoting DeepBook pool to ${(newRel / 100).toFixed(0)}%…`);
    let repricedMid: number | null = null;
    try { repricedMid = await repricePool(taskClass, newRel); log(`  ✓ pool mid now ${repricedMid ? (repricedMid * 100).toFixed(0) + "%" : "—"}`); }
    catch (e) { log(`  · reprice skipped (${String(e).slice(0, 40)})`); }

    send({
      type: "done",
      result: {
        hire: { ...h, tx: explorer(h.digest) },
        worker,
        verdict,
        evidence: { blobId, link: walrusOk ? evidenceLink(blobId) : null, walrusOk },
        resolve: { ...r, tx: explorer(r.digest) },
        agent: { before, after },
        market: { repricedMid },
      },
    });
  } catch (e) {
    console.error(e);
    send({ type: "error", error: String(e) });
  }
  res.end();
});

app.listen(env.port, () => {
  console.log(`vouch agent service → http://localhost:${env.port}`);
  console.log(`  wallet ${ME}`);
  console.log(`  worker ${hasLLM ? llmProvider + " (" + llmModel + ")" : "deterministic"}`);
});
