// Thin Anthropic SDK wrapper. Workers use WORKER_MODEL, auditor uses AUDITOR_MODEL.
// TODO(step 4): instantiate Anthropic({ apiKey }), expose a `complete()` helper that
// takes a system prompt + user content and returns text (+ raw for the trace).
import { config } from "../config.js";

export { config };
// TODO(step 4): export async function complete(opts: {...}): Promise<{ text: string; raw: unknown }>
