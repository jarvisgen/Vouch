// Live DeepBook order book for the selected task-class YES/USDC market.
// MOCK: derived from reliability via buildBook(); reprices when reliability changes.
import { OrderBook as Book } from "../mock/data";

function Row({ price, size, max, side }: { price: number; size: number; max: number; side: "bid" | "ask" }) {
  const pctWidth = Math.max(6, (size / max) * 100);
  const color = side === "bid" ? "bg-emerald-500/20" : "bg-rose-500/20";
  const text = side === "bid" ? "text-emerald-400" : "text-rose-400";
  return (
    <div className="relative grid grid-cols-2 px-2 py-0.5 text-xs tabular-nums">
      <div className={`absolute inset-y-0 right-0 ${color}`} style={{ width: `${pctWidth}%` }} />
      <span className={`relative z-10 ${text}`}>{price.toFixed(2)}</span>
      <span className="relative z-10 text-right text-slate-400">{size}</span>
    </div>
  );
}

export default function OrderBook({ book, mid }: { book: Book; mid: number }) {
  const max = Math.max(...book.bids.map((b) => b.size), ...book.asks.map((a) => a.size));
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="text-sm font-semibold text-slate-200">YES / USDC · DeepBook</span>
        <span className="text-xs text-slate-500">price = P(success)</span>
      </div>
      <div className="grid grid-cols-2 px-2 pt-2 text-[10px] uppercase text-slate-500">
        <span>price</span>
        <span className="text-right">size</span>
      </div>
      {[...book.asks].reverse().map((a, i) => (
        <Row key={`a${i}`} {...a} max={max} side="ask" />
      ))}
      <div className="my-1 border-y border-slate-800 bg-slate-950/60 px-2 py-1 text-center text-sm font-bold text-slate-100 tabular-nums">
        {mid.toFixed(2)} <span className="text-xs font-normal text-slate-500">mid</span>
      </div>
      {book.bids.map((b, i) => (
        <Row key={`b${i}`} {...b} max={max} side="bid" />
      ))}
    </div>
  );
}
