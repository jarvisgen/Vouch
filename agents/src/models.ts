// Per-agent off-chain config. An agent is either EXTERNAL (an endpoint URL the owner
// "imports" — Vouch routes jobs to it) or first-party (runs a model on our worker).
// On-chain identity/bond is real; this is just how the listed agent executes.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { llmProvider, llmModel } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PATH = join(__dirname, "..", "agent-config.json");

export interface AgentConfig {
  provider?: string; // groq | anthropic | deterministic (first-party worker)
  model?: string;
  endpoint?: string; // if set, Vouch POSTs jobs to this external URL
  feeUsdc?: number; // price the agent owner charges per task (default 5)
}

const load = (): Record<string, AgentConfig> => {
  if (!existsSync(PATH)) return {};
  try { return JSON.parse(readFileSync(PATH, "utf8")); } catch { return {}; }
};

export function getConfig(agentId: string): AgentConfig {
  return load()[agentId] ?? { provider: llmProvider, model: llmModel };
}
export function setConfig(agentId: string, cfg: AgentConfig) {
  const all = load();
  all[agentId] = cfg;
  writeFileSync(PATH, JSON.stringify(all, null, 2) + "\n");
}

// Models a first-party listing can pick (used when no external endpoint is given).
export const MODEL_CATALOG = [
  { provider: "groq", model: "llama-3.1-8b-instant" },
  { provider: "groq", model: "llama-3.3-70b-versatile" },
  { provider: "deterministic", model: "rule-engine" },
];
