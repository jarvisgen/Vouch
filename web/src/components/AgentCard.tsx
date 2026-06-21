// Agent tile: name, task class, live reliability (= on-chain), bond, jobs.
export interface AgentLike {
  taskClass: string;
  name: string;
  reliabilityBps: number;
  bondUsdc: number;
  jobs: number;
  fails: number;
}

export default function AgentCard({
  agent,
  blurb,
  taskLabel,
  tag,
  selected,
  onSelect,
}: {
  agent: AgentLike;
  blurb?: string;
  taskLabel?: string;
  tag?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const failRate = agent.jobs ? ((agent.fails / agent.jobs) * 100).toFixed(0) : "0";
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-xl border p-4 transition ${
        selected ? "border-emerald-400 bg-emerald-400/10" : "border-slate-700 bg-slate-900 hover:border-slate-500"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-slate-100">{agent.name}</div>
          <div className="text-xs uppercase tracking-wide text-slate-500">{taskLabel ?? agent.taskClass}</div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold tabular-nums text-emerald-400">{(agent.reliabilityBps / 100).toFixed(1)}</div>
          <div className="text-[10px] uppercase text-slate-500">reliability</div>
        </div>
      </div>
      {blurb && <p className="mt-2 text-xs text-slate-400">{blurb}</p>}
      {tag && (
        <div className="mt-2 inline-block rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">{tag}</div>
      )}
      <div className="mt-3 flex gap-4 text-xs text-slate-400">
        <span>bond <b className="text-slate-200">${agent.bondUsdc}</b></span>
        <span>jobs <b className="text-slate-200">{agent.jobs}</b></span>
        <span>fail rate <b className="text-slate-200">{failRate}%</b></span>
      </div>
    </button>
  );
}
