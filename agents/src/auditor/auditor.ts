// Auditor agent — the on-chain resolution oracle's brain.
// Fetches the source from Walrus (via inputHash/bundle), independently re-checks the
// worker's output for the given task class, and emits pass/fail + reason. Runs on
// AUDITOR_MODEL (the stronger model) and a separate keypair from the workers.
//
// TODO(step 4): per-task-class re-check logic mirroring each worker's objective check;
// returns AuditorVerdict { pass, reason, recomputed }.
import type { Task, WorkerOutput, AuditorVerdict } from "../types.js";

export async function audit(_task: Task, _output: WorkerOutput): Promise<AuditorVerdict> {
  throw new Error("TODO(step 4): auditor re-check");
}
