// Loads root .env + deployments/testnet.json. Single source of truth for the backend.
import { config as dotenv } from "dotenv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

dotenv({ path: join(ROOT, ".env") });

export const deployment = JSON.parse(
  readFileSync(join(ROOT, "deployments", "testnet.json"), "utf8"),
);

export const env = {
  mnemonic: process.env.SUI_MNEMONIC?.trim() ?? "",
  rpc: process.env.SUI_RPC || "https://fullnode.testnet.sui.io:443",
  // worker LLM (auditor is deterministic). Provider: groq | anthropic | none
  anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() ?? "",
  anthropicModel: process.env.WORKER_MODEL || "claude-sonnet-4-6",
  groqKey: process.env.GROQ_API_KEY?.trim() ?? "",
  groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  walrusPublisher: process.env.WALRUS_PUBLISHER || "https://publisher.walrus-testnet.walrus.space",
  walrusAggregator: process.env.WALRUS_AGGREGATOR || "https://aggregator.walrus-testnet.walrus.space",
  walrusEpochs: Number(process.env.WALRUS_EPOCHS || 5),
  port: Number(process.env.PORT || 8787),
};

// Resolve which worker LLM provider to use.
export const llmProvider =
  (process.env.LLM_PROVIDER || "").toLowerCase() ||
  (env.groqKey ? "groq" : env.anthropicKey ? "anthropic" : "none");

export const hasLLM =
  (llmProvider === "groq" && !!env.groqKey) || (llmProvider === "anthropic" && !!env.anthropicKey);

export const llmModel = llmProvider === "groq" ? env.groqModel : env.anthropicModel;
