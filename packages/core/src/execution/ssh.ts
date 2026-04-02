import { exec } from "node:child_process";
import { promisify } from "node:util";
import { loadHosts } from "../utils/config.js";

const execAsync = promisify(exec);

export async function runRemoteCommand(
  environment: string,
  command: string
): Promise<string> {
  const hosts = loadHosts();
  const entry = hosts[environment];
  if (!entry) {
    throw new Error(`No host configured for environment: ${environment}`);
  }

  const { stdout, stderr } = await execAsync(
    `ssh ${entry.host} ${JSON.stringify(command)}`,
    { timeout: 30_000 }
  );
  return stderr ? `${stdout}\n${stderr}` : stdout;
}

export async function runLocalCommand(command: string): Promise<string> {
  const { stdout, stderr } = await execAsync(command, { timeout: 30_000 });
  return stderr ? `${stdout}\n${stderr}` : stdout;
}
