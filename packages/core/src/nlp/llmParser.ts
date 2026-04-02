import type { DynamicIntent } from "../types/intent.js";
import { DynamicIntent as DynamicIntentSchema } from "../types/intent.js";
import { loadIntents } from "../utils/config.js";
import { loadRules } from "../utils/config.js";

/**
 * LLM-based fallback parser.
 *
 * Sends the raw text + context to an LLM and asks for structured JSON.
 * Set MYCLI_LLM_ENDPOINT and optionally MYCLI_LLM_API_KEY in env.
 */
export async function parseByLLM(rawText: string): Promise<DynamicIntent | null> {
  const endpoint = process.env.MYCLI_LLM_ENDPOINT;
  if (!endpoint) return null;

  const apiKey = process.env.MYCLI_LLM_API_KEY ?? "";
  const rules = loadRules();
  const intents = loadIntents();

  const systemPrompt = buildSystemPrompt(intents, rules);
  const userPrompt = `Parse this command into structured intent JSON:\n\n"${rawText}"`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({
        model: process.env.MYCLI_LLM_MODEL ?? "claude-sonnet-4-20250514",
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
  rules: ReturnType<typeof loadRules>
): string {
  const intentList = intents
    .map((i) => {
      const fields = Object.entries(i.fields)
        .map(([k, v]) => `${k}(${v.type}${v.required ? ",required" : ""})`)
        .join(", ");
      return `- ${i.name}: ${i.description} [${fields}]`;
    })
    .join("\n");

  const envs = Object.keys(rules.environmentAliases).join(", ");
  const services = Object.keys(rules.serviceAliases).join(", ");

  return `You are a command parser for a server operations CLI.
Parse the user's natural language command into a JSON object.

Supported intents:
${intentList}

Known environments: ${envs}
Known services: ${services}

Return ONLY valid JSON with:
- "intent": one of the intent names above, or "unknown"
- "confidence": 0.0 to 1.0
- "fields": object with all relevant fields for that intent

Example: {"intent": "service.restart", "confidence": 0.9, "fields": {"service": "nginx", "environment": "prod"}}

If you cannot determine the intent, return: {"intent": "unknown", "confidence": 0.1, "fields": {"reason": "..."}}
Return ONLY the JSON object, no markdown.`;
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
