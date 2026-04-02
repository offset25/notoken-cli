import { loadRules, loadIntents } from "../utils/config.js";
import type { RulePatch } from "../types/rules.js";
import { RulePatch as RulePatchSchema } from "../types/rules.js";

/**
 * RuleBuilder: asks an LLM to propose new rules from a set of example phrases.
 */
export async function buildRulesFromExamples(
  examples: string[]
): Promise<RulePatch | null> {
  const endpoint = process.env.MYCLI_LLM_ENDPOINT;
  if (!endpoint) {
    console.error("Set MYCLI_LLM_ENDPOINT to use the RuleBuilder.");
    return null;
  }

  const rules = loadRules();
  const intents = loadIntents();
  const apiKey = process.env.MYCLI_LLM_API_KEY ?? "";

  const intentList = intents.map((i) => `- ${i.name}: ${i.description}`).join("\n");

  const prompt = `You are a rule builder for a CLI command parser.

Current rules config:
${JSON.stringify(rules, null, 2)}

Supported intents (from intents.json):
${intentList}

The following user phrases were NOT understood by the current parser:
${examples.map((e) => `- "${e}"`).join("\n")}

Analyze each phrase and propose a structured patch to expand the rules.

Return a JSON object with this exact schema:
{
  "summary": "what this patch does",
  "confidence": 0.0-1.0,
  "changes": [
    { "type": "add_intent_synonym", "intent": "...", "phrase": "..." },
    { "type": "add_env_alias", "canonical": "...", "alias": "..." },
    { "type": "add_service_alias", "canonical": "...", "alias": "..." }
  ],
  "tests": [
    { "input": "...", "expectedIntent": "...", "expectedFields": {} },
    { "input": "...", "shouldReject": true }
  ],
  "warnings": ["any overlap or risk concerns"]
}

Rules:
- Only add synonyms/aliases that clearly map to existing intents or entities.
- Include at least one positive and one negative test per change.
- Warn if a new synonym could overlap with another intent.
- Do NOT invent new intents.
- Return ONLY the JSON object.`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({
        model: process.env.MYCLI_LLM_MODEL ?? "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, unknown>;
    const content = extractContent(data);
    if (!content) return null;

    const json = extractJSON(content);
    if (!json) return null;

    const parsed = RulePatchSchema.safeParse(json);
    if (!parsed.success) {
      console.error("LLM returned invalid patch:", parsed.error.message);
      return null;
    }

    return parsed.data;
  } catch (err) {
    console.error("RuleBuilder error:", err);
    return null;
  }
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
