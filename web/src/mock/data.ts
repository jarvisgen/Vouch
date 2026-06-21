// MOCK DATA LAYER — drives the demo UI end-to-end without a live chain/agent backend.
// Every value here is replaced by real reads in later steps:
//   agents      -> AgentRegistered events + Agent objects (step 4/6)
//   order books -> DeepBook pool state via useMarket() (step 5 wiring)
//   run/verdict -> agent service + auditor + Walrus (step 4)
// Each consuming component is tagged `MOCK:` where it stands in for a real read.

export type TaskClass = "clause" | "invoice" | "citation";

export interface Agent {
  id: TaskClass;
  name: string;
  taskClass: TaskClass;
  reliabilityBps: number; // 9200 = 92.00%
  bondUsdc: number;
  jobs: number;
  fails: number;
  blurb: string;
}

export interface BookLevel {
  price: number; // YES price in USDC, 0..1
  size: number; // YES contracts
}
export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

export const AGENTS: Agent[] = [
  {
    id: "clause",
    name: "ContractClauseBot",
    taskClass: "clause",
    reliabilityBps: 9200,
    bondUsdc: 10,
    jobs: 128,
    fails: 9,
    blurb: "Flags missing or risky clauses in a contract against a required checklist.",
  },
  {
    id: "invoice",
    name: "InvoiceCheckBot",
    taskClass: "invoice",
    reliabilityBps: 9650,
    bondUsdc: 8,
    jobs: 204,
    fails: 6,
    blurb: "Verifies invoice subtotals, tax and totals against line items.",
  },
  {
    id: "citation",
    name: "CitationCheckBot",
    taskClass: "citation",
    reliabilityBps: 8800,
    bondUsdc: 6,
    jobs: 76,
    fails: 11,
    blurb: "Checks that every cited quote appears verbatim in the source document.",
  },
];

export const pct = (bps: number) => (bps / 100).toFixed(1);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Premium = (1 - YES price) * coverage * load. YES price = reliability; load = margin. */
export function premiumUsdc(coverageUsdc: number, reliabilityBps: number): number {
  return round2(coverageUsdc * (1 - reliabilityBps / 10000) * 1.2);
}

/** Build a synthetic DeepBook order book centered on the YES mid-price (= reliability). */
export function buildBook(reliabilityBps: number): OrderBook {
  const mid = reliabilityBps / 10000;
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  for (let i = 1; i <= 5; i++) {
    bids.push({ price: round2(Math.max(0.01, mid - i * 0.012)), size: 40 + i * 35 });
    asks.push({ price: round2(Math.min(0.99, mid + i * 0.012)), size: 30 + i * 28 });
  }
  return { bids, asks };
}

export const SAMPLE_CONTRACT = `MUTUAL SERVICES AGREEMENT

1. Scope of Services. Provider shall deliver the services described in Exhibit A.
2. Payment Terms. Client shall pay all invoices within thirty (30) days.
3. Confidentiality. Each party shall protect the other's Confidential Information.
4. Term and Termination. Either party may terminate on 30 days' written notice.
5. Governing Law. This Agreement is governed by the laws of the State of Delaware.

[NOTE: no Limitation of Liability clause and no Indemnification clause are present.]`;

export const REQUIRED_CLAUSES = [
  "Payment Terms",
  "Confidentiality",
  "Termination",
  "Governing Law",
  "Limitation of Liability",
  "Indemnification",
];

export interface DemoOutput {
  clausesFound: { name: string; present: boolean }[];
  summary: string;
}
export interface DemoVerdict {
  pass: boolean;
  reason: string;
}

// MOCK: the worker (ContractClauseBot) "misses" two absent clauses and reports all-clear.
export const WORKER_OUTPUT: DemoOutput = {
  clausesFound: REQUIRED_CLAUSES.map((name) => ({ name, present: true })),
  summary: "All 6 required clauses detected. No issues found. Contract looks complete.",
};

// MOCK: the auditor re-checks against the Walrus-stored source and catches the miss.
export const AUDITOR_VERDICT: DemoVerdict = {
  pass: false,
  reason:
    "Worker reported 'Limitation of Liability' and 'Indemnification' as present, but neither clause exists in the source. Output is incorrect — FAIL.",
};

export const AUDITOR_VERDICT_PASS: DemoVerdict = {
  pass: true,
  reason: "All 6 required clauses verified present in the source. Output is correct — PASS.",
};

// MOCK: Walrus blob id + verifiable aggregator link for the evidence bundle.
export const MOCK_BLOB_ID = "qZ8x2vK1nF7pR3wL9cT5bH0aD6mE4yU2sJ8gN1oVxYw";
export const WALRUS_AGGREGATOR = "https://aggregator.walrus-testnet.walrus.space";
export const evidenceLink = (blobId: string) => `${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`;
