// Worker LLM provider. Supports Groq (OpenAI-compatible) and Anthropic. The auditor
// stays deterministic, so this only powers the worker's analysis.
// Returns parsed JSON + the raw trace. Callers fall back to a deterministic analyzer
// if no provider is configured or a call/parse fails.
import Anthropic from "@anthropic-ai/sdk";
import { env, llmProvider, llmModel } from "./config.js";

const anthropic = env.anthropicKey ? new Anthropic({ apiKey: env.anthropicKey }) : null;

const extractJson = (text: string) => {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
};

async function groqComplete(system: string, user: string, model: string): Promise<{ json: any; trace: string }> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.groqKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  return { json: extractJson(text), trace: text };
}

async function anthropicComplete(system: string, user: string, model: string): Promise<{ json: any; trace: string }> {
  if (!anthropic) throw new Error("no-anthropic");
  const msg = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { json: extractJson(text), trace: text };
}

/** Run the worker LLM with an explicit provider/model (per-agent), defaulting to the
 *  globally-configured provider. */
export async function workerComplete(
  system: string,
  user: string,
  cfg?: { provider: string; model: string },
): Promise<{ json: any; trace: string }> {
  const provider = cfg?.provider ?? llmProvider;
  const model = cfg?.model ?? llmModel;
  if (provider === "groq") return groqComplete(system, user, model);
  if (provider === "anthropic") return anthropicComplete(system, user, model);
  throw new Error("no-llm");
}
