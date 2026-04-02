#!/usr/bin/env node
import { runCli } from "./cli.js";

const SUBCOMMANDS = new Set(["install", "uninstall", "doctor", "check", "fix", "setup", "logs", "heal", "heal:claude"]);

async function main() {
  const args = process.argv.slice(2);

  const flags = new Set(args.filter((a) => a.startsWith("--") || a === "-y"));
  const positional = args.filter((a) => !a.startsWith("--") && a !== "-y");

  // --help
  if (flags.has("--help") && !positional.length) {
    printHelp();
    process.exit(0);
  }

  const subcommand = positional[0];
  const subArgs = positional.slice(1);

  // Direct subcommands (not NLP-parsed)
  if (subcommand && SUBCOMMANDS.has(subcommand)) {
    switch (subcommand) {
      case "install": {
        const { runInstall } = await import("./commands/install.js");
        await runInstall(subArgs);
        return;
      }
      case "uninstall": {
        const { runUninstall } = await import("./commands/install.js");
        await runUninstall(subArgs);
        return;
      }
      case "doctor": {
        const { runDoctor } = await import("./commands/doctor.js");
        await runDoctor();
        return;
      }
      case "check": {
        const { runCheckIntegration } = await import("./commands/install.js");
        await runCheckIntegration();
        return;
      }
      case "fix": {
        const { runFix } = await import("./commands/fix.js");
        await runFix(subArgs);
        return;
      }
      case "setup": {
        if (subArgs[0] === "openclaw") {
          const { runSetupOpenclaw } = await import("./commands/setup-openclaw.js");
          await runSetupOpenclaw();
        } else {
          const { runSetup } = await import("./commands/setup.js");
          await runSetup(subArgs);
        }
        return;
      }
      case "logs": {
        const { runLogs } = await import("./commands/logs.js");
        await runLogs(subArgs);
        return;
      }
      case "heal": {
        const { execSync } = await import("node:child_process");
        execSync("npx tsx src/healing/runHealer.ts " + subArgs.join(" "), { stdio: "inherit", cwd: process.cwd() });
        return;
      }
      case "heal:claude": {
        const { execSync } = await import("node:child_process");
        execSync("npx tsx src/healing/claudeHealer.ts " + subArgs.join(" "), { stdio: "inherit", cwd: process.cwd() });
        return;
      }
    }
  }

  const rawText = positional.join(" ").trim();

  // No arguments or "interactive"/"i" → interactive mode (default)
  if (!rawText || subcommand === "interactive" || subcommand === "i") {
    const { runInteractive } = await import("./interactive.js");
    await runInteractive({ autoLearn: flags.has("--auto-learn") });
    return;
  }

  // One-shot NLP mode
  await runCli(rawText, {
    dryRun: flags.has("--dry-run"),
    json: flags.has("--json"),
    yes: flags.has("--yes") || flags.has("-y"),
    verbose: flags.has("--verbose") || flags.has("--v"),
    explain: flags.has("--explain"),
  });
}

function printHelp(): void {
  console.log(`
notoken — NLP-based server operations CLI

Usage:
  notoken                              Start interactive mode (default)
  notoken "<command>"                   One-shot NLP command
  notoken install <tool>               Install a tool (claude, convex, openclaw, ollama...)
  notoken uninstall <tool>             Uninstall a tool
  notoken doctor                       Check system health and tool availability
  notoken fix <target>                 Auto-fix issues (npm, docker, git, permissions)
  notoken setup <env>                  Set up environment (dev, server, docker, node)
  notoken logs <service>               Tail service logs (nginx, docker, system, etc.)
  notoken heal                         Run auto-learning (LLM API mode)
  notoken heal:claude                  Run Claude-powered auto-learning

Options:
  --auto-learn  Auto-learn from failures via Claude (interactive mode)
  --dry-run    Parse but don't execute
  --json       Output as JSON
  --verbose    Show detailed restatement
  --yes, -y    Skip confirmations
  --help       Show this help

Examples:
  notoken                                        # interactive REPL
  notoken install claude                          # install Claude CLI
  notoken doctor                                  # check system health
  notoken fix npm                                 # fix npm issues
  notoken setup dev                               # set up dev environment
  notoken logs nginx                              # tail nginx logs
  notoken "restart nginx on prod" --dry-run       # NLP one-shot
  MYCLI_LLM_CLI=claude notoken --auto-learn        # interactive + auto-learn
`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
