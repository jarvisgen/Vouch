// +completion-guarantee toggle. Premium = (1 - YES price) * coverage, market-derived.
export default function GuaranteeToggle({
  enabled,
  onToggle,
  feeUsdc,
  coverageUsdc,
  premiumUsdc,
  reliabilityBps,
}: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  feeUsdc: number;
  coverageUsdc: number;
  premiumUsdc: number;
  reliabilityBps: number;
}) {
  const premiumPct = ((premiumUsdc / feeUsdc) * 100).toFixed(1);
  const total = enabled ? feeUsdc + premiumUsdc : feeUsdc;
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
      <label className="flex cursor-pointer items-center justify-between">
        <div>
          <div className="font-semibold text-slate-100">Completion guarantee</div>
          <div className="text-xs text-slate-400">
            Refunds ${coverageUsdc} if the auditor rules the work failed.
          </div>
        </div>
        <button
          onClick={() => onToggle(!enabled)}
          className={`relative h-6 w-11 rounded-full transition ${enabled ? "bg-emerald-500" : "bg-slate-600"}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${enabled ? "left-[22px]" : "left-0.5"}`}
          />
        </button>
      </label>

      <div className="mt-4 space-y-1 text-sm">
        <div className="flex justify-between text-slate-300">
          <span>Task fee</span>
          <span className="tabular-nums">${feeUsdc.toFixed(2)}</span>
        </div>
        <div className={`flex justify-between ${enabled ? "text-slate-300" : "text-slate-600 line-through"}`}>
          <span>
            Premium <span className="text-xs text-slate-500">(+{premiumPct}% · priced off {(reliabilityBps / 100).toFixed(0)}% odds)</span>
          </span>
          <span className="tabular-nums">${premiumUsdc.toFixed(2)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-800 pt-1 font-semibold text-slate-100">
          <span>Total (one PTB)</span>
          <span className="tabular-nums">${total.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
