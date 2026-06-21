// Shared types across the agent layer. The evidence bundle is the contract between
// worker → Walrus → auditor → on-chain resolution.

export type TaskClass = "clause" | "invoice" | "citation";

export interface Task {
  id: string;
  taskClass: TaskClass;
  /** raw input the worker operates on (contract text, invoice JSON, doc + citations) */
  input: string;
  /** sha256 of `input` — recorded on-chain + in the bundle so the auditor sees the same source */
  inputHash: string;
}

export interface WorkerOutput {
  agentId: string;
  taskClass: TaskClass;
  /** structured result — shape depends on task class (see workers/) */
  result: unknown;
  /** the model's reasoning trace, stored for auditability */
  trace: string;
}

export interface AuditorVerdict {
  pass: boolean;
  reason: string;
  /** auditor's independent recomputation, for the evidence bundle */
  recomputed: unknown;
}

/** The full bundle stored on Walrus; its blobId resolves market + policy on-chain. */
export interface EvidenceBundle {
  task: Task;
  output: WorkerOutput;
  verdict: AuditorVerdict;
  createdAt: string; // ISO; stamped by the caller, not inside a workflow
}
