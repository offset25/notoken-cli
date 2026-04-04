/**
 * Confidence Calibrator — tracks classifier accuracy over time.
 *
 * Records whether each classifier's votes were correct (user didn't
 * correct them). Over time, adjusts confidence based on track record:
 *   - Classifiers with high accuracy get a boost
 *   - Classifiers that frequently vote wrong get penalized
 *
 * Persists to ~/.notoken/classifier-stats.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const STATS_PATH = resolve(homedir(), ".notoken", "classifier-stats.json");

interface ClassifierStats {
  /** Number of times this classifier voted for the winning intent */
  correct: number;
  /** Total votes from this classifier */
  total: number;
  /** Running accuracy (correct/total) */
  accuracy: number;
  /** Calibration multiplier: >1.0 = boosted, <1.0 = penalized */
  multiplier: number;
}

interface CalibrationData {
  classifiers: Record<string, ClassifierStats>;
  /** Total intents executed (for decay) */
  totalExecutions: number;
  lastUpdated: string;
}

let _data: CalibrationData | null = null;

function load(): CalibrationData {
  if (_data) return _data;
  if (existsSync(STATS_PATH)) {
    try { _data = JSON.parse(readFileSync(STATS_PATH, "utf-8")); return _data!; } catch {}
  }
  _data = { classifiers: {}, totalExecutions: 0, lastUpdated: new Date().toISOString() };
  return _data;
}

function save(): void {
  const data = load();
  data.lastUpdated = new Date().toISOString();
  const dir = resolve(STATS_PATH, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATS_PATH, JSON.stringify(data, null, 2));
}

/**
 * Record the outcome of a classification round.
 * Call after execution — classifiers that voted for the winning intent
 * get credit, others don't.
 */
export function recordOutcome(
  votes: Array<{ classifier: string; intent: string }>,
  winningIntent: string
): void {
  const data = load();
  data.totalExecutions++;

  for (const vote of votes) {
    if (!data.classifiers[vote.classifier]) {
      data.classifiers[vote.classifier] = { correct: 0, total: 0, accuracy: 0.5, multiplier: 1.0 };
    }
    const stats = data.classifiers[vote.classifier];
    stats.total++;
    if (vote.intent === winningIntent) stats.correct++;

    // Update accuracy with exponential moving average (recent results weighted more)
    const newAccuracy = stats.correct / stats.total;
    stats.accuracy = stats.total < 10 ? newAccuracy : stats.accuracy * 0.9 + newAccuracy * 0.1;

    // Calibration multiplier: sigmoid-like curve centered at 0.5 accuracy
    // accuracy 0.8 → multiplier 1.15, accuracy 0.3 → multiplier 0.85
    stats.multiplier = 0.7 + (stats.accuracy * 0.6);
  }

  // Save every 10 executions
  if (data.totalExecutions % 10 === 0) save();
}

/**
 * Get the calibration multiplier for a classifier.
 * Returns 1.0 if no data (neutral).
 */
export function getMultiplier(classifier: string): number {
  const data = load();
  return data.classifiers[classifier]?.multiplier ?? 1.0;
}

/**
 * Apply calibration to a set of classifier votes.
 * Adjusts each vote's confidence by the classifier's track record.
 */
export function calibrateVotes(
  votes: Array<{ classifier: string; intent: string; confidence: number }>
): Array<{ classifier: string; intent: string; confidence: number }> {
  return votes.map(v => ({
    ...v,
    confidence: Math.min(1.0, v.confidence * getMultiplier(v.classifier)),
  }));
}

/**
 * Record that a user corrected a misroute.
 * Penalizes classifiers that voted for the wrong intent.
 */
export function recordCorrection(
  votes: Array<{ classifier: string; intent: string }>,
  wrongIntent: string,
  correctIntent: string
): void {
  const data = load();
  for (const vote of votes) {
    if (!data.classifiers[vote.classifier]) {
      data.classifiers[vote.classifier] = { correct: 0, total: 0, accuracy: 0.5, multiplier: 1.0 };
    }
    const stats = data.classifiers[vote.classifier];
    if (vote.intent === wrongIntent) {
      // This classifier voted wrong — penalize more strongly
      stats.total += 2; // Double penalty
      stats.accuracy = stats.accuracy * 0.85;
      stats.multiplier = 0.7 + (stats.accuracy * 0.6);
    } else if (vote.intent === correctIntent) {
      // This classifier had the right answer — reward
      stats.correct += 2;
      stats.total += 2;
      stats.accuracy = stats.accuracy * 0.9 + 0.1;
      stats.multiplier = 0.7 + (stats.accuracy * 0.6);
    }
  }
  save();
}

/**
 * Get stats for display/debugging.
 */
export function getCalibrationStats(): Record<string, ClassifierStats> {
  return { ...load().classifiers };
}

/** Flush stats to disk. */
export function flushCalibration(): void { save(); }
