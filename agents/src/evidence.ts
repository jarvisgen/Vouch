// Builds the evidence bundle and hashes task input. The inputHash links the on-chain
// record to the exact source the auditor re-checks.
//
// TODO(step 4): sha256(input) via node:crypto; assemble EvidenceBundle from
// Task + WorkerOutput + AuditorVerdict; createdAt stamped here (ISO).
import type { Task, WorkerOutput, AuditorVerdict, EvidenceBundle } from "./types.js";

export function hashInput(_input: string): string {
  throw new Error("TODO(step 4): sha256");
}

export function buildBundle(
  _task: Task,
  _output: WorkerOutput,
  _verdict: AuditorVerdict,
): EvidenceBundle {
  throw new Error("TODO(step 4): assemble bundle");
}
