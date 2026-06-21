// InvoiceCheckBot — task-class "invoice".
// OBJECTIVE task: given invoice line items, verify totals/tax/subtotal arithmetic.
// Auditor recomputes the sums independently.
//
// TODO(step 4): output schema { subtotal, tax, total, correct: boolean, discrepancies[] }
import type { Task, WorkerOutput } from "../types.js";

export async function run(_task: Task): Promise<WorkerOutput> {
  throw new Error("TODO(step 4): InvoiceBot");
}
