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
