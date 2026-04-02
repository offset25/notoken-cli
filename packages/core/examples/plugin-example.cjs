/**
 * Example notoken plugin.
 *
 * This shows every feature a plugin can use.
 * Copy this file and modify it to create your own plugin.
 *
 * Quick start:
 *   1. Copy this to ~/.notoken/plugins/my-plugin.js
 *   2. Edit the intents, playbooks, and hooks
 *   3. Restart notoken — your plugin is loaded automatically
 *
 * Or publish as npm package:
 *   1. Create a package named notoken-plugin-yourname
 *   2. Export the plugin object as default
 *   3. npm install -g notoken-plugin-yourname
 *   4. Restart notoken — discovered automatically
 */

module.exports = {
  // Required: unique name
  name: "example",
  version: "1.0.0",
  description: "Example plugin showing all features",
  author: "Your Name",

  // ── New intents (commands users can type) ──
  intents: [
    {
      name: "example.hello",
      description: "Say hello from the example plugin",
      synonyms: ["example hello", "test plugin", "plugin test"],
      command: "echo 'Hello from the example plugin!'",
      execution: "local",       // "local" or "remote"
      riskLevel: "low",         // "low", "medium", "high"
      requiresConfirmation: false,
      examples: ["example hello", "test the plugin"],
    },
    {
      name: "example.deploy",
      description: "Deploy our custom app",
      synonyms: ["deploy myapp", "ship myapp", "release myapp"],
      fields: {
        environment: { type: "environment", required: true, default: "staging" },
        branch: { type: "branch", required: false, default: "main" },
      },
      command: "cd /srv/myapp && git pull origin {{branch}} && npm run build && pm2 restart myapp",
      execution: "remote",
      riskLevel: "high",
      requiresConfirmation: true,
      examples: ["deploy myapp to prod", "ship myapp on staging"],
    },
  ],

  // ── New playbooks (multi-step recipes) ──
  playbooks: [
    {
      name: "example-check",
      description: "Example health check playbook",
      steps: [
        { command: "echo 'Step 1: checking...'", label: "Check something" },
        { command: "uptime", label: "Check uptime" },
        { command: "echo 'All good!'", label: "Done" },
      ],
    },
  ],

  // ── New service/environment aliases ──
  aliases: {
    services: {
      myapp: ["myapp", "my-app", "our-app"],
      mydb: ["mydb", "our-database"],
    },
    environments: {
      qa: ["qa", "quality"],
    },
  },

  // ── Lifecycle hooks ──
  hooks: {
    // Called when plugin loads
    onLoad: async () => {
      console.log("[example-plugin] Loaded!");
    },

    // Called before ANY intent executes (not just this plugin's)
    // Return false to cancel execution
    beforeExecute: async (intent) => {
      // Example: block production deploys on Friday
      if (intent.intent.includes("deploy") && intent.fields.environment === "prod") {
        const day = new Date().getDay();
        if (day === 5) {
          console.log("[example-plugin] No production deploys on Friday!");
          return false; // cancels the execution
        }
      }
      // Return nothing (or true) to allow execution
    },

    // Called after ANY intent executes successfully
    afterExecute: async (intent, result) => {
      // Example: log all commands to a file
      // require("fs").appendFileSync("/tmp/notoken-audit.log",
      //   `${new Date().toISOString()} ${intent.intent} ${JSON.stringify(intent.fields)}\n`
      // );
    },

    // Called when execution fails
    onError: async (intent, error) => {
      // Example: send alert to Slack
      // await fetch("https://hooks.slack.com/...", { method: "POST", body: JSON.stringify({ text: `notoken error: ${error.message}` }) });
    },

    // Called when no intent matches — return a result to handle it
    onUnknown: async (rawText) => {
      // Example: check if it matches your custom commands
      if (rawText.toLowerCase().includes("myapp status")) {
        return {
          intent: "example.hello",
          fields: {},
          confidence: 0.8,
        };
      }
      return null; // pass to next plugin or show "unknown"
    },

    // Called when plugin unloads
    onUnload: async () => {
      console.log("[example-plugin] Unloaded!");
    },
  },
};
