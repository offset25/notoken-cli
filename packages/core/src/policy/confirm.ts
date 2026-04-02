import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function askForConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Require the user to type an exact phrase to confirm a dangerous action.
 * Returns true only if the typed text matches exactly.
 */
export async function askForStrictConfirmation(
  message: string,
  requiredPhrase: string
): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${message}\n  Type "${requiredPhrase}" to confirm: `);
    return answer.trim() === requiredPhrase;
  } finally {
    rl.close();
  }
}

/**
 * Ask with extended responses: y/n plus control flow.
 * Returns: "yes" | "no" | "all" | "stop"
 */
export async function askWithControl(
  message: string
): Promise<"yes" | "no" | "all" | "stop"> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} [y/N/all/stop] `);
    const trimmed = answer.trim().toLowerCase();

    // Yes
    if (/^y(es)?$/.test(trimmed)) return "yes";

    // All / do everything / keep going / clean everything
    if (/^(all|yes.?all|do.?all|everything|clean.?(all|everything)|keep.?going|do.?it|go.?ahead)$/.test(trimmed)) return "all";

    // Stop / abort / quit / enough / don't / no more / stop right there
    if (/^(stop|abort|quit|enough|no.?more|that.?s?.?enough|stop.?right.?there|cancel|done|don.?t|nah|exit)$/.test(trimmed)) return "stop";

    // Default: no
    return "no";
  } finally {
    rl.close();
  }
}

export async function askForChoice(
  message: string,
  choices: string[]
): Promise<string | null> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log(message);
    for (let i = 0; i < choices.length; i++) {
      console.log(`  ${i + 1}. ${choices[i]}`);
    }
    const answer = await rl.question("Choose (number): ");
    const idx = Number(answer.trim()) - 1;
    if (idx >= 0 && idx < choices.length) return choices[idx];
    return null;
  } finally {
    rl.close();
  }
}
