import { fork, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type AgentStatus = "running" | "completed" | "failed" | "killed";

export interface AgentHandle {
  id: number;
  name: string;
  description: string;
  status: AgentStatus;
  pid?: number;
  startedAt: Date;
  completedAt?: Date;
  output: string[];
  error?: string;
  acknowledged: boolean;
}

/**
 * AgentSpawner — spawns long-running child processes (agents) in the background.
 *
 * Unlike TaskRunner (which runs async functions in-process), AgentSpawner
 * forks actual child processes that can run independently. Useful for:
 * - Long SSH sessions
 * - Tailing logs in real-time
 * - Monitoring tasks
 * - Parallel multi-server operations
 */
export class AgentSpawner extends EventEmitter {
  private agents: Map<number, AgentHandle> = new Map();
  private processes: Map<number, ChildProcess> = new Map();
  private nextId = 1;

  /**
   * Spawn a new agent that runs a shell command.
   */
  spawnCommand(
    name: string,
    description: string,
    command: string,
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): AgentHandle {
    const agent: AgentHandle = {
      id: this.nextId++,
      name,
      description,
      status: "running",
      startedAt: new Date(),
      output: [],
      acknowledged: false,
    };

    this.agents.set(agent.id, agent);

    // Use a worker script that executes the command
    const workerPath = resolve(__dirname, "worker.ts");
    const child = fork(workerPath, [command], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      execArgv: ["--import", "tsx"],
    });

    agent.pid = child.pid;
    this.processes.set(agent.id, child);

    child.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        agent.output.push(line);
        this.emit("agent:output", agent, line);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        agent.output.push(`[err] ${line}`);
        this.emit("agent:output", agent, `[err] ${line}`);
      }
    });

    child.on("close", (code) => {
      if (agent.status === "killed") return;
      agent.status = code === 0 ? "completed" : "failed";
      agent.completedAt = new Date();
      if (code !== 0) agent.error = `Exit code: ${code}`;
      this.processes.delete(agent.id);
      this.emit("agent:done", agent);
    });

    child.on("error", (err) => {
      agent.status = "failed";
      agent.error = err.message;
      agent.completedAt = new Date();
      this.processes.delete(agent.id);
      this.emit("agent:done", agent);
    });

    this.emit("agent:started", agent);
    return agent;
  }

  /**
   * Spawn a command using exec (simpler, no worker needed).
   */
  spawnShell(
    name: string,
    description: string,
    command: string,
  ): AgentHandle {
    const { exec } = require("node:child_process") as typeof import("node:child_process");

    const agent: AgentHandle = {
      id: this.nextId++,
      name,
      description,
      status: "running",
      startedAt: new Date(),
      output: [],
      acknowledged: false,
    };

    this.agents.set(agent.id, agent);

    const child = exec(command, { timeout: 300_000 });
    agent.pid = child.pid;

    child.stdout?.on("data", (data: string | Buffer) => {
      const line = data.toString().trim();
      if (line) {
        agent.output.push(line);
        this.emit("agent:output", agent, line);
      }
    });

    child.stderr?.on("data", (data: string | Buffer) => {
      const line = data.toString().trim();
      if (line) {
        agent.output.push(`[err] ${line}`);
        this.emit("agent:output", agent, `[err] ${line}`);
      }
    });

    child.on("close", (code) => {
      if (agent.status === "killed") return;
      agent.status = code === 0 ? "completed" : "failed";
      agent.completedAt = new Date();
      if (code !== 0) agent.error = `Exit code: ${code}`;
      this.emit("agent:done", agent);
    });

    this.emit("agent:started", agent);
    return agent;
  }

  /** Kill an agent by ID. */
  kill(id: number): boolean {
    const agent = this.agents.get(id);
    if (!agent || agent.status !== "running") return false;

    const proc = this.processes.get(id);
    if (proc) {
      proc.kill("SIGTERM");
      this.processes.delete(id);
    }

    // Also try killing by PID for shell-spawned agents
    if (agent.pid) {
      try { process.kill(agent.pid, "SIGTERM"); } catch {}
    }

    agent.status = "killed";
    agent.completedAt = new Date();
    this.emit("agent:done", agent);
    return true;
  }

  /** Get an agent by ID. */
  get(id: number): AgentHandle | undefined {
    return this.agents.get(id);
  }

  /** List all agents. */
  list(filter?: AgentStatus): AgentHandle[] {
    const all = Array.from(this.agents.values());
    return filter ? all.filter((a) => a.status === filter) : all;
  }

  /** Get agents that finished since the user last checked. */
  getUnacknowledged(): AgentHandle[] {
    return Array.from(this.agents.values()).filter(
      (a) => !a.acknowledged && a.status !== "running"
    );
  }

  /** Mark an agent as acknowledged. */
  acknowledge(id: number): void {
    const agent = this.agents.get(id);
    if (agent) agent.acknowledged = true;
  }

  acknowledgeAll(): void {
    for (const agent of this.agents.values()) {
      if (agent.status !== "running") agent.acknowledged = true;
    }
  }

  /** Get count of running agents. */
  get active(): number {
    return Array.from(this.agents.values()).filter((a) => a.status === "running").length;
  }

  /** Get last N lines of output from an agent. */
  getOutput(id: number, lines = 20): string[] {
    const agent = this.agents.get(id);
    if (!agent) return [];
    return agent.output.slice(-lines);
  }
}

export const agentSpawner = new AgentSpawner();
