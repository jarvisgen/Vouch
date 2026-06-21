// ContractClauseBot — task-class "clause".
// OBJECTIVE task: given contract text + a checklist of required clauses, report which
// required clauses are present/absent (booleans + spans). Auditor re-checks presence,
// so the verdict is defensible.
//
// TODO(step 4): system prompt + JSON output schema { clauses: {name, present, span}[] }
import type { Task, WorkerOutput } from "../types.js";

export async function run(_task: Task): Promise<WorkerOutput> {
  throw new Error("TODO(step 4): ClauseBot");
}
