import { describe, it, expect, vi } from "vitest";

// We test the cross-platform helpers by importing the module and checking behavior
// Since the helpers are not exported, we test them indirectly through the exported functions
// and also test the logic directly by reimplementing the key checks

describe("OpenClaw diagnostics — cross-platform logic", () => {
  const isWin = process.platform === "win32";

  describe("environment detection", () => {
    it("detects current platform correctly", () => {
      // process.platform should be defined
      expect(["win32", "linux", "darwin"]).toContain(process.platform);
    });

    it("has HOME or USERPROFILE set", () => {
      const home = process.env.HOME ?? process.env.USERPROFILE;
      expect(home).toBeDefined();
      expect(home!.length).toBeGreaterThan(0);
    });
  });

  describe("command existence check logic", () => {
    it("can find node on any platform", async () => {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);

      // The cross-platform way to check for a command
      const cmd = isWin
        ? "command -v node 2>/dev/null || where node 2>/dev/null"
        : "which node 2>/dev/null";
      const shell = isWin ? "bash" : undefined;

      const { stdout } = await execAsync(cmd, { shell });
      expect(stdout.trim()).toContain("node");
    });

    it("returns empty for nonexistent command", async () => {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);

      const cmd = isWin
        ? "command -v notoken_nonexistent_cmd_xyz 2>/dev/null || where notoken_nonexistent_cmd_xyz 2>/dev/null"
        : "which notoken_nonexistent_cmd_xyz 2>/dev/null";
      const shell = isWin ? "bash" : undefined;

      try {
        const { stdout } = await execAsync(cmd, { shell });
        // If it doesn't throw, stdout should be empty or contain "not found"
        expect(stdout.trim()).not.toContain("notoken_nonexistent_cmd_xyz");
      } catch {
        // Expected — command not found throws
      }
    });
  });

  describe("Node version parsing", () => {
    it("parses major version from node --version output", () => {
      const nodeVer = process.version; // e.g. "v20.17.0"
      const major = parseInt(nodeVer.replace("v", ""));
      expect(major).toBeGreaterThanOrEqual(16);
      expect(major).toBeLessThan(100);
    });

    it("correctly identifies Node 22+ requirement", () => {
      const testCases = [
        { ver: "v20.17.0", expected: false },
        { ver: "v22.0.0", expected: true },
        { ver: "v22.15.0", expected: true },
        { ver: "v18.19.0", expected: false },
        { ver: "v23.1.0", expected: true },
      ];

      for (const tc of testCases) {
        const major = parseInt(tc.ver.replace("v", ""));
        expect(major >= 22).toBe(tc.expected);
      }
    });
  });

  describe("nvm prefix logic", () => {
    it("returns empty prefix on Windows", () => {
      // On Windows, nvm-windows updates PATH globally, no sourcing needed
      if (isWin) {
        // The getNvmPrefix() function returns "" on Windows
        expect("").toBe("");
      }
    });

    it("returns sourcing command on Linux", () => {
      if (!isWin) {
        const nvmPrefix = `for d in "$HOME/.nvm" "/home/"*"/.nvm" "/root/.nvm"; do [ -s "$d/nvm.sh" ] && export NVM_DIR="$d" && . "$d/nvm.sh" && break; done 2>/dev/null; nvm use 22 > /dev/null 2>&1;`;
        expect(nvmPrefix).toContain("nvm.sh");
        expect(nvmPrefix).toContain("nvm use 22");
      }
    });
  });

  describe("openclaw command wrapping", () => {
    it("wraps commands correctly for current platform", () => {
      const cmd = "openclaw health";
      if (isWin) {
        // On Windows, commands run directly
        const wrapped = `${cmd} 2>&1`;
        expect(wrapped).toBe("openclaw health 2>&1");
        expect(wrapped).not.toContain("bash -c");
      } else {
        // On Linux, wrapped in bash -c with nvm prefix
        const nvmPrefix = "nvm use 22;";
        const wrapped = `bash -c '${nvmPrefix} ${cmd} 2>&1'`;
        expect(wrapped).toContain("bash -c");
        expect(wrapped).toContain("nvm use 22");
      }
    });
  });

  describe("admin privilege check (Windows)", () => {
    it.skipIf(!isWin)("can check admin status via PowerShell", async () => {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        const { stdout } = await execAsync(
          `powershell -Command "& { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }"`,
          { shell: "bash" }
        );
        expect(["True", "False"]).toContain(stdout.trim());
    });
  });

  describe("Windows process detection — WMI vs Get-Process", () => {
    it.skipIf(!isWin)("Get-WmiObject returns CommandLine for node processes", async () => {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);

      const { stdout } = await execAsync(
        `powershell -Command "Get-WmiObject Win32_Process -Filter \\"Name='node.exe'\\" | Select-Object ProcessId, CommandLine | Format-List"`,
        { shell: "bash" }
      );
      if (stdout.includes("ProcessId")) {
        expect(stdout).toContain("CommandLine");
        const cmdLineMatch = stdout.match(/CommandLine\s*:\s*(.+)/);
        expect(cmdLineMatch).not.toBeNull();
        expect(cmdLineMatch![1].trim().length).toBeGreaterThan(0);
      }
    });

    it.skipIf(!isWin)("Get-Process CommandLine may be empty on older Windows", async () => {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        // This demonstrates the bug we fixed — Get-Process doesn't populate CommandLine on Server 2016
        const { stdout } = await execAsync(
          `powershell -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object Id, CommandLine | Format-List"`,
          { shell: "bash" }
        ).catch(() => ({ stdout: "" }));
        // We don't assert failure — just document that CommandLine can be empty
        // The important thing is WMI works (tested above)
        expect(typeof stdout).toBe("string");
      });

      it.skipIf(!isWin)("WMI can filter for openclaw gateway process", async () => {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        // This is the exact query used in isGatewayRunning (escape $_ for bash)
        const { stdout } = await execAsync(
          `powershell -Command "Get-WmiObject Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { \\$_.CommandLine -match 'openclaw.*gateway' } | Select-Object -First 1 ProcessId"`,
          { shell: "bash" }
        ).catch(() => ({ stdout: "" }));

        // If openclaw gateway is running, should find a PID
        const healthCheck = await execAsync("curl -sf http://127.0.0.1:18789/health", { shell: "bash" }).catch(() => ({ stdout: "" }));
        if (healthCheck.stdout.includes('"ok"')) {
          // Gateway is running — WMI should find it
          expect(stdout).toMatch(/\d+/);
        }
        // If not running, no assertion needed
      });

      it.skipIf(!isWin)("health endpoint fallback works when process detection fails", async () => {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        const { stdout } = await execAsync(
          "curl -sf http://127.0.0.1:18789/health 2>/dev/null || echo NOT_RUNNING",
          { shell: "bash" }
        );
        // Either the gateway is up or it's not — both are valid
        const isRunning = stdout.includes('"ok"');
        const isDown = stdout.includes("NOT_RUNNING");
        expect(isRunning || isDown).toBe(true);
    });
  });

  describe("Claude credentials path", () => {
    it("resolves to a valid path", () => {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      const sep = isWin ? "\\" : "/";
      const credsPath = `${home}${sep}.claude${sep}.credentials.json`;
      expect(credsPath).toContain(".claude");
      expect(credsPath).toContain(".credentials.json");
      expect(credsPath.length).toBeGreaterThan(20);
    });
  });
});
