import type { DynamicIntent } from "../types/intent.js";
import { DynamicIntent as DynamicIntentSchema } from "../types/intent.js";
import { loadIntents } from "../utils/config.js";
import { loadRules } from "../utils/config.js";

/**
 * LLM-based fallback parser.
 *
 * Sends the raw text + context to an LLM and asks for structured JSON.
 * Set NOTOKEN_LLM_ENDPOINT and optionally NOTOKEN_LLM_API_KEY in env.
 */
export async function parseByLLM(
  rawText: string,
  nearMisses?: Array<{ intent: string; score: number; source: string }>
): Promise<DynamicIntent | null> {
  const endpoint = process.env.NOTOKEN_LLM_ENDPOINT;
  if (!endpoint) return null;

  const apiKey = process.env.NOTOKEN_LLM_API_KEY ?? "";
  const rules = loadRules();
  const intents = loadIntents();

  const systemPrompt = buildSystemPrompt(intents, rules, nearMisses);
  const userPrompt = `Parse this command into structured intent JSON:\n\n"${rawText}"`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({
        model: process.env.NOTOKEN_LLM_MODEL ?? "claude-sonnet-4-20250514",
        max_tokens: 512,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, unknown>;
    const content = extractContent(data);
    if (!content) return null;

    const json = extractJSON(content);
    if (!json) return null;

    // Reshape LLM output into DynamicIntent
    const intent = json.intent as string;
    const confidence = json.confidence as number;
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(json)) {
      if (!["intent", "confidence", "rawText"].includes(k)) {
        fields[k] = v;
      }
    }

    const parsed = DynamicIntentSchema.safeParse({ intent, confidence, rawText, fields });
    if (!parsed.success) return null;

    return parsed.data;
  } catch {
    return null;
  }
}

function buildSystemPrompt(
  intents: ReturnType<typeof loadIntents>,
  rules: ReturnType<typeof loadRules>,
  nearMisses?: Array<{ intent: string; score: number; source: string }>
): string {
  // Build a concise intent list grouped by domain
  const domains = new Map<string, string[]>();
  for (const i of intents) {
    const domain = i.name.split(".")[0];
    if (!domains.has(domain)) domains.set(domain, []);
    const fields = Object.entries(i.fields).map(([k, v]) => `${k}:${v.type}`).join(", ");
    domains.get(domain)!.push(`${i.name}${fields ? ` [${fields}]` : ""}`);
  }

  // If we have near-misses, show their full details + related intents
  let nearMissSection = "";
  if (nearMisses && nearMisses.length > 0) {
    const nearMissDetails = nearMisses
      .filter((v, i, a) => a.findIndex(x => x.intent === v.intent) === i) // dedup
      .slice(0, 5)
      .map(nm => {
        const def = intents.find(i => i.name === nm.intent);
        const fields = def ? Object.entries(def.fields).map(([k, v]) => `${k}:${v.type}`).join(", ") : "";
        return `  - ${nm.intent} (${(nm.score * 100).toFixed(0)}% from ${nm.source}): ${def?.description ?? ""}${fields ? ` [${fields}]` : ""}`;
      }).join("\n");

    // Also include related intents from the same domains
    const nearDomains = new Set(nearMisses.map(nm => nm.intent.split(".")[0]));
    const relatedIntents = [...nearDomains].flatMap(d => (domains.get(d) ?? []).slice(0, 5)).join("\n    ");

    nearMissSection = `\nNEAR MATCHES (my classifiers think it might be one of these — pick the best or suggest another):
${nearMissDetails}

RELATED COMMANDS in those domains:
    ${relatedIntents}\n`;
  }

  // Compact domain summary for everything else
  const domainSummary = [...domains].map(([d, items]) =>
    `  [${d}]: ${items.slice(0, 4).join(", ")}${items.length > 4 ? ` +${items.length - 4} more` : ""}`
  ).join("\n");

  const envs = Object.keys(rules.environmentAliases).join(", ");
  const services = Object.keys(rules.serviceAliases).join(", ");

  return `You are NoToken, a server operations CLI command parser.
Parse the user's natural language into a structured JSON intent.
${nearMissSection}
ALL AVAILABLE COMMANDS (${intents.length} total):
${domainSummary}

Known environments: ${envs}
Known services: ${services}

Return ONLY valid JSON:
{"intent": "domain.command", "confidence": 0.0-1.0, "fields": {"field": "value"}}

If unclear, return: {"intent": "unknown", "confidence": 0.1, "fields": {"reason": "...", "clarification": "What did you mean? Did you want to..."}}
Return ONLY JSON, no markdown.`;
}

function extractContent(data: Record<string, unknown>): string | null {
  if (data.choices && Array.isArray(data.choices)) {
    const msg = (data.choices as Array<Record<string, unknown>>)[0]?.message as Record<string, unknown> | undefined;
    if (msg?.content && typeof msg.content === "string") return msg.content;
  }
  if (data.content && Array.isArray(data.content)) {
    const block = (data.content as Array<Record<string, unknown>>)[0];
    if (block?.text && typeof block.text === "string") return block.text;
  }
  return null;
}

function extractJSON(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text.trim()); } catch {}
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) { try { return JSON.parse(match[1].trim()); } catch {} }
  return null;
}
