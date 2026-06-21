// CitationCheckBot — task-class "citation".
// OBJECTIVE task: given a document + cited quotes, verify each quote appears verbatim
// in the source. Auditor re-checks string presence.
//
// TODO(step 4): output schema { citations: {quote, found, location}[] }
import type { Task, WorkerOutput } from "../types.js";

export async function run(_task: Task): Promise<WorkerOutput> {
  throw new Error("TODO(step 4): CitationBot");
}
