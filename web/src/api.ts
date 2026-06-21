// Client for the Vouch agent backend (real on-chain + Walrus + worker/auditor).
//  - local dev: call the backend directly on :8787 (same http scheme, CORS allowed).
//  - deployed: call the Render backend directly (permissive CORS; keeps SSE streaming).
//  - VITE_API overrides both.
const RENDER_API = "https://vouch-backend-rtdi.onrender.com";
const isLocal = typeof location !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const BASE = (import.meta as any).env?.VITE_API ?? (isLocal ? "http://localhost:8787" : RENDER_API);

export interface ModelCfg {
  provider: string;
  model: string;
}
export interface TaskMeta {
  label: string;
  agent: string;
  blurb: string;
  does?: string;
  how?: string;
  inputHint?: string;
  examples?: string[];
}
export interface ApiAgent {
  id: string;
  taskClass: "clause" | "invoice" | "citation";
  name: string;
  owner: string;
  reliabilityBps: number;
  bondUsdc: number;
  jobs: number;
  fails: number;
  config?: { provider?: string; model?: string; endpoint?: string; feeUsdc?: number };
}

export interface RunResult {
  hire: { tx: string; feeUsdc: number; protocolFeeUsdc: number; agentNetUsdc: number; premiumUsdc: number; coverageUsdc: number; reliabilityBps: number };
  worker: { mode: "claude" | "deterministic"; result: any; trace: string };
  verdict: { pass: boolean; reason: string; recomputed: any };
  evidence: { blobId: string; link: string | null; walrusOk: boolean };
  resolve: { tx: string; payoutUsdc: number; slashedUsdc: number; newReliabilityBps: number };
  agent: { before: ApiAgent; after: ApiAgent };
}

async function j<T>(p: Promise<Response>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

export interface MarketView {
  source: "deepbook" | "synthetic";
  poolId: string | null;
  reliabilityBps: number;
  book: { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] };
}

export const api = {
  health: () => j<{ ok: boolean; llm: boolean; provider: string; model: string | null; wallet: string; packageId: string }>(fetch(`${BASE}/api/health`)),
  agents: () => j<ApiAgent[]>(fetch(`${BASE}/api/agents`)),
  market: (tc: string) => j<MarketView>(fetch(`${BASE}/api/market/${tc}`)),
  samples: (tc: string) => j<{ clean: string; tricky: string }>(fetch(`${BASE}/api/samples/${tc}`)),
  models: () => j<ModelCfg[]>(fetch(`${BASE}/api/models`)),
  tasks: () => j<Record<string, TaskMeta>>(fetch(`${BASE}/api/tasks`)),
  activity: () => j<{ ts: number; kind: string; label: string; digest: string; tx: string }[]>(fetch(`${BASE}/api/activity`)),
  revenue: () => j<{ feesUsdc: number; premiumsUsdc: number; payoutsUsdc: number; slashedUsdc: number; netInsuranceUsdc: number; totalUsdc: number; treasury: string }>(fetch(`${BASE}/api/revenue`)),
  trade: (taskClass: string, side: "buy" | "sell", price: number, size: number) =>
    j<{ mid: number; poolId: string }>(fetch(`${BASE}/api/trade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskClass, side, price, size }) })),
  resolve: (taskClass: string, text: string) =>
    j<{ status: "exact" | "suggest" | "none"; input?: string; label?: string; help?: string }>(fetch(`${BASE}/api/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskClass, text }) })),
  runStream,
  createAgent: (body: { name: string; taskClass: string; bondUsdc: number; feeUsdc: number; endpoint?: string; provider?: string; model?: string }) =>
    j<{ agentId: string; tx: string }>(fetch(`${BASE}/api/agents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })),
  setPrice: (id: string, feeUsdc: number) =>
    j<{ ok: boolean; feeUsdc: number }>(fetch(`${BASE}/api/agents/${id}/price`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feeUsdc }) })),
};

// Streamed run: reads SSE lines from /api/run, calling onLog per step, resolving with the result.
async function runStream(
  body: { agentId: string; input: string; withGuarantee: boolean },
  onLog: (line: string) => void,
): Promise<RunResult> {
  const res = await fetch(`${BASE}/api/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.body) throw new Error("no stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let result: RunResult | null = null;
  let error: string | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!chunk.startsWith("data:")) continue;
      const o = JSON.parse(chunk.slice(5).trim());
      if (o.type === "log") onLog(o.msg);
      else if (o.type === "done") result = o.result;
      else if (o.type === "error") error = o.error;
    }
  }
  if (error) throw new Error(error);
  if (!result) throw new Error("run did not complete");
  return result;
}
