import { expect } from "vitest";
import type { ParsedCommand } from "../../../src/types/intent.js";

export function assertValidParse(
  result: ParsedCommand,
  expectedIntent: string,
  minConfidence = 0.6
): void {
  expect(result.intent.intent).toBe(expectedIntent);
  expect(result.intent.confidence).toBeGreaterThanOrEqual(minConfidence);
}

export function assertHasField(
  result: ParsedCommand,
  fieldName: string,
  expectedValue?: unknown
): void {
  expect(result.intent.fields).toHaveProperty(fieldName);
  if (expectedValue !== undefined) {
    expect(result.intent.fields[fieldName]).toBe(expectedValue);
  }
}

export function assertNeedsClarification(result: ParsedCommand): void {
  expect(result.needsClarification).toBe(true);
}

export function assertNoClarification(result: ParsedCommand): void {
  expect(result.needsClarification).toBe(false);
}
