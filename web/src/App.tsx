import { useEffect, useRef, useState } from "react";
import { ConnectButton, useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import AgentCard from "./components/AgentCard";
import OrderBook from "./components/OrderBook";
import GuaranteeToggle from "./components/GuaranteeToggle";
import { premiumUsdc } from "./mock/data";
import { api, ApiAgent, MarketView, RunResult, TaskMeta } from "./api";

type Health = { llm: boolean; provider: string; wallet: string; packageId: string; stable: string; reservePool: string; treasury: string; backend: string };

export default function App() {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signTx } = useSignAndExecuteTransaction();
  const [health, setHealth] = useState<Health | null>(null);
  const [funding, setFunding] = useState(false);
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [selId, setSelId] = useState<string>("");
  const [market, setMarket] = useState<MarketView | null>(null);
  const [samples, setSamples] = useState<{ clean: string; tricky: string } | null>(null);
  const [input, setInput] = useState("");
  const [guarantee, setGuarantee] = useState(true);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [taskMeta, setTaskMeta] = useState<Record<string, TaskMeta>>({});
  const [trading, setTrading] = useState(false);
  const [tradePrice, setTradePrice] = useState("");
  const [tradeSize, setTradeSize] = useState(10);
  const [activity, setActivity] = useState<{ ts: number; kind: string; label: string; tx: string }[]>([]);
  const [termLines, setTermLines] = useState<string[]>([]);
  const [pending, setPending] = useState<{ label: string; input: string } | null>(null);
  const [rev, setRev] = useState<{ feesUsdc: number; premiumsUsdc: number; payoutsUsdc: number; slashedUsdc: number; netInsuranceUsdc: number; totalUsdc: number } | null>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const meta = (tc: string) => taskMeta[tc];
  const refreshActivity = () => api.activity().then(setActivity).catch(() => {});
  const refreshRev = () => api.revenue().then(setRev).catch(() => {});

  const selected = agents.find((a) => a.id === selId);
  const taskClass = selected?.taskClass ?? "clause";
  const reliability = market?.reliabilityBps ?? selected?.reliabilityBps ?? 9000;
  const fee = selected?.config?.feeUsdc ?? 5;
  const premium = premiumUsdc(fee, selected?.reliabilityBps ?? 9000);

  const refreshAgents = () => api.agents().then((a) => { setAgents(a); if (!selId && a[0]) setSelId(a[0].id); }).catch((e) => setErr(String(e)));
  const refreshMarket = (tc: string) => api.market(tc).then(setMarket).catch(() => {});

  useEffect(() => {
    api.health().then(setHealth).catch(() =>
      setErr(
        /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
          ? "Backend not reachable on :8787 — start it with `pnpm agents`."
          : "Backend waking up (free tier cold start ~30–50s) — retry in a moment.",
      ),
    );
    api.tasks().then(setTaskMeta).catch(() => {});
    refreshAgents();
    refreshActivity();
    refreshRev();
    const t = setInterval(() => { refreshActivity(); refreshRev(); }, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!selected) return;
    api.samples(taskClass).then(setSamples);
    setInput("");
    setPending(null);
    setResult(null);
    setMarket(null);
    refreshMarket(taskClass);
    const t = setInterval(() => refreshMarket(taskClass), 5000);
    return () => clearInterval(t);
  }, [selId, taskClass]);

  async function trade(side: "buy" | "sell") {
    const price = tradePrice ? parseFloat(tradePrice) : +(reliability / 10000).toFixed(2);
    setTrading(true); setErr(null);
    try { await api.trade(taskClass, side, price, Number(tradeSize)); await refreshMarket(taskClass); await refreshActivity(); }
    catch (e) { setErr(String(e)); } finally { setTrading(false); }
  }

  useEffect(() => { if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight; }, [termLines]);

  // Build + sign the hire from the CONNECTED wallet (user pays). Returns the hire payload
  // for the backend to finish (work → audit → resolve). Throws if the user rejects.
  async function signHire() {
    if (!selected || !health || !account) throw new Error("connect a wallet first");
    const feeBase = BigInt(Math.round((selected.config?.feeUsdc ?? 5) * 1e6));
    const protocolCut = (feeBase * 1000n) / 10000n;
    const agentCut = feeBase - protocolCut;
    const coverage = guarantee ? agentCut : 0n;
    const premium = guarantee ? BigInt(Math.round(Number(coverage) * (1 - selected.reliabilityBps / 10000) * 1.2)) : 0n;
    const tx = new Transaction();
    tx.transferObjects([coinWithBalance({ type: health.stable, balance: protocolCut })], health.treasury); // platform fee
    tx.transferObjects([coinWithBalance({ type: health.stable, balance: agentCut })], health.backend); // escrow
    tx.moveCall({
      target: `${health.packageId}::insurance::buy_policy`,
      typeArguments: [health.stable],
      arguments: [
        tx.object(health.reservePool),
        tx.pure.address(selected.id),
        tx.pure.vector("u8", Array.from(new TextEncoder().encode(taskClass))),
        tx.pure.u64(coverage),
        coinWithBalance({ type: health.stable, balance: premium }),
      ],
    });
    const signed = await signTx({ transaction: tx as any }); // dapp-kit bundles a slightly older @mysten/sui Transaction type
    const full = await suiClient.waitForTransaction({ digest: signed.digest, options: { showObjectChanges: true } });
    const created = (full.objectChanges || []).find((c: any) => c.type === "created" && String(c.objectType).includes("::insurance::Policy<")) as any;
    if (!created?.objectId) throw new Error("hire didn't create a policy — is your wallet funded?");
    return {
      policyId: created.objectId as string,
      agentNetUsdc: Number(agentCut) / 1e6,
      protocolFeeUsdc: Number(protocolCut) / 1e6,
      premiumUsdc: Number(premium) / 1e6,
      coverageUsdc: Number(coverage) / 1e6,
      userAddress: account.address,
    };
  }

  async function fund() {
    if (!account) return;
    setFunding(true); setErr(null);
    try { const f = await api.faucet(account.address); setTermLines((l) => [...l, `✓ funded your wallet with ${f.usdc} mUSDC + ${f.sui} SUI`]); }
    catch (e) { setErr(String(e)); } finally { setFunding(false); }
  }

  async function run() {
    if (!selected) return;
    setErr(null); setPending(null);
    try {
      const r = await api.resolve(taskClass, input);
      if (r.status === "none") { setErr(r.help || "Couldn't understand that input."); return; }
      if (r.status === "suggest") { setPending({ label: r.label!, input: r.input! }); return; }
      await doRun(r.input!);
    } catch (e) { setErr(String(e)); }
  }

  async function doRun(resolvedInput: string) {
    if (!selected) return;
    setPending(null);
    setRunning(true); setErr(null); setResult(null);
    setTermLines((l) => [...l, `$ run · ${selected.name} · ${meta(taskClass)?.label}`]);
    try {
      let hire: Awaited<ReturnType<typeof signHire>> | undefined;
      if (account && health) {
        setTermLines((l) => [...l, "HIRE  approve the payment in your wallet…"]);
        const h = await signHire();
        hire = h;
        setTermLines((l) => [...l, `  ✓ paid from your wallet · policy ${h.policyId.slice(0, 10)}…`]);
      }
      const r = await api.runStream({ agentId: selected.id, input: resolvedInput, withGuarantee: guarantee, hire }, (line) => setTermLines((l) => [...l.slice(-300), line]));
      setResult(r);
      await refreshAgents();
      await refreshMarket(taskClass);
      await refreshActivity();
      await refreshRev();
    } catch (e) { setErr(String(e)); setTermLines((l) => [...l, `! ${String(e)}`]); } finally { setRunning(false); }
  }

  const passRate = selected && selected.jobs ? Math.round(((selected.jobs - selected.fails) / selected.jobs) * 100) : 100;
  const dot: Record<string, string> = { "move-audit": "bg-slate-700", "coin-safety": "bg-slate-700", route: "bg-slate-700", general: "bg-slate-700" };
  const term = [
    `vouch trust terminal — ${health ? "live · testnet · worker " + health.provider : "connecting…"}`,
    ...(termLines.length ? termLines.slice(-40) : ["idle · select an agent and Hire & run to stream live on-chain steps"]),
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <button onClick={() => { window.location.hash = ""; }} className="text-base font-bold tracking-tight hover:text-emerald-300" title="Home">⬡ Vouch</button>
          {selected && <span className="rounded-md bg-slate-800 px-2 py-1 text-xs text-slate-200">{selected.name}</span>}
          <span className="hidden text-xs text-slate-500 md:inline">{meta(taskClass)?.label} terminal · testnet</span>
        </div>
        <div className="flex items-center gap-2">
          {rev && (
            <div className="hidden rounded-lg border border-slate-800 bg-slate-900 px-3 py-1 text-right sm:block" title={`fees $${rev.feesUsdc} + underwriting $${rev.netInsuranceUsdc} (premiums $${rev.premiumsUsdc} − payouts $${rev.payoutsUsdc} + bonds recovered $${rev.slashedUsdc})`}>
              <div className="text-sm font-bold tabular-nums text-slate-100">${rev.totalUsdc.toFixed(2)}</div>
              <div className="text-[9px] uppercase tracking-wide text-slate-500">protocol revenue</div>
            </div>
          )}
          {account && (
            <button onClick={fund} disabled={funding} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:border-emerald-500 hover:text-emerald-300 disabled:opacity-50">
              {funding ? "Funding…" : "Fund wallet"}
            </button>
          )}
          <ConnectButton />
        </div>
      </header>

      {err && <div className="bg-rose-500/10 px-4 py-1 text-xs text-rose-300">{err}</div>}

      <div ref={termRef} className="mx-3 mt-3 h-28 shrink-0 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-400">
        {term.map((l, i) => <div key={i} className="whitespace-pre">{`> ${l}`}</div>)}
        <span className="animate-pulse">▌</span>
      </div>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-12">
        {/* Agents — one expandable list */}
        <Panel title="Agents" className="lg:col-span-5 lg:order-1" right={<span className="text-[10px] text-slate-500">{agents.length} listed</span>}>
          <div className="space-y-2">
            {[...agents].sort((a, b) => b.reliabilityBps - a.reliabilityBps).map((a) => {
              const open = a.id === selId;
              return (
                <div key={a.id} className={`overflow-hidden rounded-lg border ${open ? "border-emerald-400 bg-emerald-400/5" : "border-slate-800"}`}>
                  <button onClick={() => !running && setSelId(open ? "" : a.id)} className="flex w-full items-center gap-3 p-2.5 text-left hover:bg-slate-800/40">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white ${dot[a.taskClass] ?? "bg-slate-600"}`}>{a.name[0]}</div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-200">{a.name}</div>
                      <div className="truncate text-[11px] text-slate-500">{meta(a.taskClass)?.label} · {meta(a.taskClass)?.blurb}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold tabular-nums text-slate-200">{(a.reliabilityBps / 100).toFixed(0)}%</div>
                      <div className="text-[10px] text-slate-500">${a.config?.feeUsdc ?? 5}/task</div>
                    </div>
                    <span className="text-slate-500">{open ? "▾" : "▸"}</span>
                  </button>
                  {open && (
                    <div className="space-y-3 border-t border-slate-800 p-3 text-xs">
                      <p className="leading-relaxed text-slate-300">{meta(a.taskClass)?.does}</p>
                      <div className="rounded-lg bg-slate-950 p-2">
                        <div className="text-[10px] uppercase tracking-wide text-slate-500">accepted input</div>
                        <div className="text-slate-300">{meta(a.taskClass)?.inputHint}</div>
                      </div>
                      <p className="text-slate-500"><b className="text-slate-400">Verified by:</b> {meta(a.taskClass)?.how}</p>
                      <div className="space-y-1">
                        <Row k="worker" v={a.config?.endpoint ? "external endpoint" : a.config?.model ?? "—"} />
                        <Row k="bond staked" v={`$${a.bondUsdc}`} />
                        <Row k="jobs / fails" v={`${a.jobs} / ${a.fails}`} />
                        <Row k="owner" v={`${a.owner.slice(0, 6)}…${a.owner.slice(-4)}`} />
                      </div>
                      <PriceEditor agent={a} feeUsdc={a.config?.feeUsdc ?? 5} onSaved={refreshAgents} />
                    </div>
                  )}
                </div>
              );
            })}
            {!agents.length && <div className="text-sm text-slate-500">No agents — import one.</div>}
          </div>
        </Panel>

        {/* DeepBook market — right */}
        <Panel title="DeepBook market" className="lg:col-span-3 lg:order-3"
          right={<span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${market?.source === "deepbook" ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-700 text-slate-400"}`}>{market?.source === "deepbook" ? "● live" : "synthetic"}</span>}>
          {market?.source === "deepbook" ? (
            <>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">YES / USDC · price = P(success)</div>
              <OrderBook book={market.book} mid={reliability / 10000} />
              <div className="mt-3 grid grid-cols-2 gap-2">
                <input type="number" min={0.01} max={0.99} step={0.01} value={tradePrice} onChange={(e) => setTradePrice(e.target.value)} placeholder={`price ${(reliability / 10000).toFixed(2)}`} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs" />
                <input type="number" min={1} step={1} value={tradeSize} onChange={(e) => setTradeSize(Number(e.target.value))} placeholder="size" className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs" />
              </div>
              <div className="mt-2 flex gap-2">
                <button disabled={trading} onClick={() => trade("buy")} className="flex-1 rounded-lg bg-emerald-500/90 px-2 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-40">Buy YES ↑</button>
                <button disabled={trading} onClick={() => trade("sell")} className="flex-1 rounded-lg bg-rose-500/90 px-2 py-1.5 text-xs font-semibold text-slate-950 hover:bg-rose-400 disabled:opacity-40">Sell YES ↓</button>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">{trading ? "Placing order on DeepBook…" : "Real DeepBook limit order — moves the live mid."}</p>
              {market.poolId && <a href={`https://suiscan.xyz/testnet/object/${market.poolId}`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[11px] text-emerald-400 underline">pool on Suiscan ↗</a>}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-6 text-center text-xs text-slate-500">
              <div className="mb-1 text-2xl">⚖︎</div>
              No DeepBook market for this agent.<br />Its reliability comes from <b className="text-slate-300">auditor verdicts</b>, not trading.
            </div>
          )}

          {/* simple recent on-chain transactions */}
          <div className="mt-3 border-t border-slate-800 pt-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Recent transactions</div>
            <div className="space-y-1">
              {activity.slice(0, 6).map((a, i) => (
                <a key={i} href={a.tx} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-2 text-[11px] text-slate-400 hover:text-slate-200">
                  <span className="truncate"><span className="uppercase text-slate-500">{a.kind}</span> {a.label}</span>
                  <span className="shrink-0 text-emerald-400">↗</span>
                </a>
              ))}
              {!activity.length && <div className="text-[11px] text-slate-600">No transactions yet.</div>}
            </div>
          </div>
        </Panel>

        {/* Hire + result */}
        <Panel title={`Hire ${selected?.name ?? ""}`} className="lg:col-span-4 lg:order-2"
          right={<span className="text-xs font-semibold text-emerald-300">${fee.toFixed(0)}/task</span>}>
          <div className="space-y-3">
            {samples && (
              <div className="flex justify-end gap-1 text-[11px]">
                <button disabled={running} onClick={() => setInput(samples.clean)} className="rounded px-2 py-0.5 text-slate-400 hover:bg-slate-800">example</button>
                <button disabled={running} onClick={() => setInput(samples.tricky)} className="rounded px-2 py-0.5 text-slate-400 hover:bg-slate-800">hard example</button>
              </div>
            )}
            <textarea value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} placeholder={meta(taskClass)?.inputHint}
              className="h-24 w-full resize-none rounded-xl border border-slate-700 bg-slate-950 p-2.5 font-mono text-[11px] text-slate-300" />
            {!!meta(taskClass)?.examples?.length && (
              <div className="flex flex-wrap gap-1">
                <span className="text-[10px] text-slate-600">try:</span>
                {meta(taskClass)!.examples!.map((ex, i) => (
                  <button key={i} disabled={running} onClick={() => setInput(ex)}
                    className="max-w-[180px] truncate rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400 hover:border-emerald-500 hover:text-emerald-300">
                    {ex}
                  </button>
                ))}
              </div>
            )}
            <label className="flex cursor-pointer items-center justify-between text-xs">
              <span className="text-slate-300">Guarantee · refund ${fee} on fail <span className="text-slate-500">(premium ${premium.toFixed(2)})</span></span>
              <button onClick={() => setGuarantee(!guarantee)} className={`relative h-5 w-9 rounded-full transition ${guarantee ? "bg-emerald-500" : "bg-slate-600"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${guarantee ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </label>
            {pending && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                <div className="text-amber-200">No exact match — did you mean <b>{pending.label}</b>?</div>
                <div className="mt-2 flex gap-2">
                  <button onClick={() => doRun(pending.input)} className="flex-1 rounded-lg bg-amber-400 px-3 py-1.5 font-semibold text-slate-950 hover:bg-amber-300">Yes, use it</button>
                  <button onClick={() => setPending(null)} className="rounded-lg border border-slate-600 px-3 py-1.5 text-slate-300 hover:bg-slate-800">Cancel</button>
                </div>
              </div>
            )}
            <button onClick={run} disabled={running || !selected} className="w-full rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50">
              {running ? "Working on-chain…" : `Hire & run · $${(guarantee ? fee + premium : fee).toFixed(2)}`}
            </button>
            {result && <ResultChat r={result} />}

            {/* Reliability — just below hire */}
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Reliability</div>
              <div className="flex justify-around">
                <Ring value={reliability / 100} label="reliability" />
                <Ring value={passRate} label="pass rate" tone="slate" />
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                <Tile k="jobs" v={`${selected?.jobs ?? 0}`} />
                <Tile k="fails" v={`${selected?.fails ?? 0}`} tone={selected?.fails ? "rose" : undefined} />
                <Tile k="price" v={`$${fee.toFixed(0)}`} />
                <Tile k="premium" v={`$${premium.toFixed(2)}`} />
              </div>
            </div>
          </div>
        </Panel>
      </main>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between"><span className="text-slate-500">{k}</span><span className="text-slate-300">{v}</span></div>;
}
function Tile({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 py-2">
      <div className={`text-lg font-bold tabular-nums ${tone === "rose" ? "text-rose-400" : "text-slate-200"}`}>{v}</div>
      <div className="text-[10px] uppercase text-slate-500">{k}</div>
    </div>
  );
}
function Ring({ value, label, tone = "emerald" }: { value: number; label: string; tone?: string }) {
  const r = 26, c = 2 * Math.PI * r, pct = Math.max(0, Math.min(100, value));
  const stroke = tone === "slate" ? "#64748b" : tone === "rose" ? "#fb7185" : "#34d399";
  return (
    <div className="flex flex-col items-center">
      <div className="relative h-16 w-16">
        <svg className="h-16 w-16 -rotate-90">
          <circle cx="32" cy="32" r={r} stroke="#1e293b" strokeWidth="5" fill="none" />
          <circle cx="32" cy="32" r={r} stroke={stroke} strokeWidth="5" fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} strokeLinecap="round" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-sm font-bold">{Math.round(pct)}</div>
      </div>
      <div className="mt-1 text-[10px] text-slate-400">{label}</div>
    </div>
  );
}
function Panel({ title, right, children, className = "" }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex min-h-0 flex-col rounded-xl border border-slate-800 bg-slate-900/60 ${className}`}>
      <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <span className="text-sm font-medium text-slate-200">{title}</span>
        {right}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
    </div>
  );
}
function FormattedResult({ taskClass, result }: { taskClass: string; result: any }) {
  if (!result) return <span className="text-slate-500">—</span>;
  if (taskClass === "general")
    return <p className="whitespace-pre-wrap break-words leading-relaxed text-slate-200">{result.answer ?? JSON.stringify(result)}</p>;
  if (taskClass === "coin-safety")
    return (
      <div className="space-y-1">
        <div className="flex justify-between"><span className="text-slate-400">Can be frozen (deny-list)</span><b className={result.freezable ? "text-rose-300" : "text-slate-200"}>{result.freezable ? "Yes ⚠" : "No"}</b></div>
        <div className="flex justify-between"><span className="text-slate-400">Publicly mintable</span><b className={result.publiclyMintable ? "text-rose-300" : "text-slate-200"}>{result.publiclyMintable ? "Yes ⚠" : "No"}</b></div>
      </div>
    );
  if (taskClass === "route")
    return (
      <div className="space-y-1">
        <div className="flex justify-between"><span className="text-slate-400">Best route</span><b className="text-slate-100">{result.bestDex}</b></div>
        <div className="flex justify-between"><span className="text-slate-400">Output</span><b className="text-slate-100 tabular-nums">{result.amountOut}</b></div>
      </div>
    );
  if (taskClass === "move-audit") {
    const risky: string[] = result.risky ?? [];
    return risky.length ? (
      <div>
        <div className="mb-1 text-slate-400">{risky.length} ungated privileged function{risky.length > 1 ? "s" : ""}:</div>
        <ul className="space-y-0.5">{risky.map((f, i) => <li key={i} className="font-mono text-rose-300">• {f}</li>)}</ul>
      </div>
    ) : <span className="text-slate-200">No ungated privileged functions found.</span>;
  }
  if (taskClass === "wallet-report") {
    const coins: any[] = result.coins ?? [];
    const sym = (t: string) => t.split("::").pop() || t;
    return (
      <div className="space-y-2">
        {result.summary && <p className="text-slate-200">{result.summary}</p>}
        <div className="flex gap-4 text-slate-400"><span>coin types <b className="text-slate-100">{result.coinTypes}</b></span><span>objects <b className="text-slate-100">{result.objects}</b></span></div>
        <div className="space-y-0.5">
          {coins.slice(0, 8).map((c, i) => (
            <div key={i} className="flex justify-between font-mono text-[11px]"><span className="text-slate-400">{sym(c.coinType)}</span><span className="text-slate-200 tabular-nums">{c.balance}</span></div>
          ))}
          {coins.length > 8 && <div className="text-[10px] text-slate-500">+{coins.length - 8} more</div>}
        </div>
      </div>
    );
  }
  if (taskClass === "token-brief") {
    const t = result.thesis ?? {};
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <div className="flex justify-between"><span className="text-slate-400">symbol</span><b className="text-slate-100">{result.symbol ?? "—"}</b></div>
          <div className="flex justify-between"><span className="text-slate-400">decimals</span><b className="text-slate-100">{result.decimals ?? "—"}</b></div>
          <div className="flex justify-between"><span className="text-slate-400">supply</span><b className="text-slate-100 tabular-nums">{result.supply ?? "—"}</b></div>
          <div className="flex justify-between"><span className="text-slate-400">freezable</span><b className={result.freezable ? "text-rose-300" : "text-slate-200"}>{result.freezable ? "Yes" : "No"}</b></div>
        </div>
        <div className="rounded bg-slate-800/40 p-2"><span className="text-[10px] uppercase text-slate-500">thesis</span>
          {t.useCase && <p className="text-slate-300"><b className="text-slate-400">Use case:</b> {t.useCase}</p>}
          {t.risks && <p className="text-slate-300"><b className="text-slate-400">Risks:</b> {t.risks}</p>}
          {t.catalysts && <p className="text-slate-300"><b className="text-slate-400">Catalysts:</b> {t.catalysts}</p>}
        </div>
        <p className="text-[10px] text-slate-500">facts verified on-chain · thesis judged (best-effort)</p>
      </div>
    );
  }
  if (taskClass === "defi-health") {
    const hf = Number(result.healthFactor);
    return (
      <div className="space-y-1">
        <div className="flex justify-between"><span className="text-slate-400">Health factor</span><b className={hf < 1.2 ? "text-rose-300" : hf < 1.5 ? "text-amber-300" : "text-emerald-300"}>{result.healthFactor}</b></div>
        <div className="flex justify-between"><span className="text-slate-400">Liquidation buffer</span><b className="text-slate-100">{result.maxDrawdownPct}% drop</b></div>
      </div>
    );
  }
  return <pre className="whitespace-pre-wrap break-words text-slate-200">{JSON.stringify(result, null, 1)}</pre>;
}

function ResultChat({ r }: { r: RunResult }) {
  const fail = !r.verdict.pass;
  const tc = r.agent.before.taskClass;
  return (
    <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs">
      {!fail ? (
        <>
          {/* PASS: the result is the point — lead with it */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Result</span>
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">✓ verified by auditor</span>
          </div>
          <div className="rounded-lg bg-slate-900 p-3 text-sm"><FormattedResult taskClass={tc} result={r.worker.result} /></div>
          <div className="text-[11px] text-slate-500">{r.verdict.reason} · agent earned ${r.hire.agentNetUsdc} · reliability {(r.agent.before.reliabilityBps / 100).toFixed(0)}→{(r.agent.after.reliabilityBps / 100).toFixed(0)}%</div>
        </>
      ) : (
        <>
          {/* FAIL: the problem + your refund is the point */}
          <div className="rounded-lg bg-rose-500/15 p-3">
            <div className="mb-0.5 font-bold text-rose-300">✗ Auditor rejected this result</div>
            <div className="text-slate-300">{r.verdict.reason}</div>
          </div>
          <div className="rounded-lg border border-rose-500/20 bg-emerald-500/5 p-2 text-[11px] text-slate-300">
            You were protected: <b className="text-slate-100">${r.hire.agentNetUsdc} refunded</b>, agent earned <b className="text-slate-100">$0</b>, bond slashed <b className="text-slate-100">${r.resolve.slashedUsdc}</b>.
          </div>
          <details className="text-[11px] text-slate-500">
            <summary className="cursor-pointer">show the rejected output</summary>
            <div className="mt-1 rounded bg-slate-900 p-2"><FormattedResult taskClass={tc} result={r.worker.result} /></div>
          </details>
        </>
      )}
      <div className="flex flex-wrap gap-3 border-t border-slate-800 pt-2 text-slate-400">
        {r.evidence.link && <a href={r.evidence.link} target="_blank" rel="noreferrer" className="text-emerald-400 underline">evidence ↗</a>}
        <a href={r.resolve.tx} target="_blank" rel="noreferrer" className="text-emerald-400 underline">on-chain proof ↗</a>
        <span className="ml-auto text-[10px] text-slate-600">via {r.worker.mode}</span>
      </div>
    </div>
  );
}

// ---- the transparent pipeline + auditor side-by-side ----
function Pipeline({ r }: { r: RunResult }) {
  const fail = !r.verdict.pass;
  return (
    <div className="space-y-3 rounded-xl border border-slate-700 bg-slate-900 p-4">
      <ol className="space-y-2 text-sm">
        <Step n="1" label={`Hired — paid $${r.hire.feeUsdc.toFixed(2)} fee + $${r.hire.premiumUsdc.toFixed(2)} premium`} link={r.hire.tx} linkLabel="hire tx ↗" />
        <Step n="2" label={`Worker (${r.worker.mode}) produced an answer`} />
        <Step n="3" label={`Auditor independently re-checked vs ground truth → ${fail ? "FAIL" : "PASS"}`} bad={fail} good={!fail} />
        <Step n="4" label="Evidence written to Walrus" link={r.evidence.link ?? undefined} linkLabel="evidence ↗" />
        <Step n="5" label={`Resolved on-chain${fail ? ` — paid you $${r.resolve.payoutUsdc.toFixed(2)}, slashed $${r.resolve.slashedUsdc.toFixed(2)}` : " — premium retained"}`} link={r.resolve.tx} linkLabel="resolve tx ↗" />
      </ol>

      {/* the trust moment: what the agent said vs what the auditor verified */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-slate-950/60 p-3">
          <div className="mb-1 text-[10px] uppercase text-slate-500">Agent computed</div>
          <pre className="whitespace-pre-wrap break-words text-[11px] text-slate-300">{JSON.stringify(r.worker.result, null, 1)}</pre>
        </div>
        <div className="rounded-lg bg-slate-950/60 p-3">
          <div className="mb-1 text-[10px] uppercase text-emerald-400">Auditor verified (ground truth)</div>
          <pre className="whitespace-pre-wrap break-words text-[11px] text-slate-300">{JSON.stringify(r.verdict.recomputed, null, 1)}</pre>
        </div>
      </div>
      <div className={`rounded-lg p-2 text-xs ${fail ? "bg-rose-500/15 text-rose-200" : "bg-emerald-500/15 text-emerald-200"}`}>
        <b>{fail ? "FAIL" : "PASS"}:</b> {r.verdict.reason}
      </div>
      <div className="text-xs text-slate-400">
        reliability <b className="text-slate-200">{(r.agent.before.reliabilityBps / 100).toFixed(1)}%</b> → <b className={fail ? "text-rose-300" : "text-emerald-300"}>{(r.agent.after.reliabilityBps / 100).toFixed(1)}%</b>
        {"  ·  bond "}<b className="text-slate-200">${r.agent.before.bondUsdc}</b> → <b className="text-slate-200">${r.agent.after.bondUsdc}</b>
      </div>
    </div>
  );
}

function Step({ n, label, link, linkLabel, good, bad }: { n: string; label: string; link?: string; linkLabel?: string; good?: boolean; bad?: boolean }) {
  return (
    <li className="flex items-center gap-3">
      <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${bad ? "bg-rose-500 text-white" : good ? "bg-emerald-500 text-slate-950" : "bg-emerald-500 text-slate-950"}`}>✓</span>
      <span className={bad ? "text-rose-300" : "text-slate-200"}>{label}</span>
      {link && <a href={link} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-emerald-400 underline">{linkLabel}</a>}
    </li>
  );
}

// ---- agent owner sets / edits the task price ----
function PriceEditor({ agent, feeUsdc, onSaved }: { agent: ApiAgent; feeUsdc: number; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(feeUsdc));
  const [busy, setBusy] = useState(false);
  useEffect(() => setVal(String(feeUsdc)), [feeUsdc, agent.id]);
  async function save() {
    setBusy(true);
    try { await api.setPrice(agent.id, Number(val)); onSaved(); setEditing(false); } finally { setBusy(false); }
  }
  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm">
      <span className="text-slate-400">Task price <span className="text-[11px] text-slate-600">(set by owner)</span></span>
      {editing ? (
        <span className="flex items-center gap-2">
          <span className="text-slate-500">$</span>
          <input type="number" min={1} step={1} value={val} onChange={(e) => setVal(e.target.value)} className="w-16 rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-sm" />
          <button disabled={busy} onClick={save} className="rounded bg-emerald-500 px-2 py-0.5 text-xs font-semibold text-slate-950">save</button>
          <button onClick={() => setEditing(false)} className="text-xs text-slate-500">cancel</button>
        </span>
      ) : (
        <span className="flex items-center gap-2">
          <b className="text-slate-200">${feeUsdc.toFixed(2)}</b>
          <button onClick={() => setEditing(true)} className="text-xs text-emerald-400 hover:underline">edit</button>
        </span>
      )}
    </div>
  );
}

// ---- live DeepBook + settlement transaction feed ----
function ActivityFeed({ items }: { items: { ts: number; kind: string; label: string; tx: string }[] }) {
  const color: Record<string, string> = {};
  return (
    <section className="mx-auto max-w-7xl px-6 pb-6 pt-2">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
        On-chain activity · DeepBook orders &amp; settlement
      </h2>
      <div className="max-h-64 divide-y divide-slate-800 overflow-auto rounded-xl border border-slate-800 bg-slate-900">
        {items.length === 0 && <div className="p-3 text-xs text-slate-500">No transactions yet — place a trade or hire an agent.</div>}
        {items.map((a, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-1.5 text-xs">
            <span className={`w-20 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase ${color[a.kind] ?? "bg-slate-700 text-slate-300"}`}>{a.kind}</span>
            <span className="flex-1 truncate text-slate-300">{a.label}</span>
            <a href={a.tx} target="_blank" rel="noreferrer" className="shrink-0 text-emerald-400 underline">tx ↗</a>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- how trust works ----
function TrustExplainer() {
  return (
    <section className="mx-auto max-w-7xl px-6 pb-12 pt-2">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">How trust works</h2>
      <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-4">
        <Info title="Objective tasks only" body="Agents only take tasks with a checkable right answer — invoice math, required clauses, verbatim citations — so a verdict isn't an opinion." />
        <Info title="An independent auditor" body="A separate on-chain auditor re-computes the answer from scratch and is the only key allowed to settle. Today it's a single keypair (MVP); production uses multiple staked auditors + disputes." />
        <Info title="Skin in the game" body="Every agent stakes a bond that is slashed when it fails, and pays you back via insurance. Its DeepBook market price is its live, tradable reliability." />
        <Info title="Verify everything" body="The full evidence bundle (input, output, verdict) is stored on Walrus, and every hire/resolve is a real Sui transaction — all linked from each run above." />
      </div>
    </section>
  );
}
function Info({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="mb-1 font-semibold text-slate-200">{title}</div>
      <p className="text-xs text-slate-400">{body}</p>
    </div>
  );
}
