import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

// ─── Credentials file parsing ────────────────────────────────────────────────

function readCredentialsFile(content: string): { username?: string; password?: string } {
  const lines = content.trim().split("\n").map((l) => l.trim()).filter(Boolean);

  // KEY=VALUE format
  const kvUser = lines.find((l) => /^(USER|USERNAME)=/i.test(l));
  const kvPass = lines.find((l) => /^(PASS|PASSWORD)=/i.test(l));
  if (kvUser || kvPass) {
    return {
      username: kvUser?.split("=").slice(1).join("="),
      password: kvPass?.split("=").slice(1).join("="),
    };
  }

  // username:password (single line)
  if (lines.length === 1 && lines[0].includes(":")) {
    const [username, ...rest] = lines[0].split(":");
    return { username, password: rest.join(":") };
  }

  // Line 1 = username, line 2 = password
  return {
    username: lines[0] || undefined,
    password: lines[1] || undefined,
  };
}

describe("credentials file parsing", () => {
  it("parses KEY=VALUE format", () => {
    const creds = readCredentialsFile("USERNAME=admin\nPASSWORD=secret123");
    expect(creds.username).toBe("admin");
    expect(creds.password).toBe("secret123");
  });

  it("parses KEY=VALUE case-insensitive", () => {
    const creds = readCredentialsFile("user=deploy\npass=mypass");
    expect(creds.username).toBe("deploy");
    expect(creds.password).toBe("mypass");
  });

  it("parses username:password single line", () => {
    const creds = readCredentialsFile("admin:secret123");
    expect(creds.username).toBe("admin");
    expect(creds.password).toBe("secret123");
  });

  it("handles password with colons", () => {
    const creds = readCredentialsFile("admin:pass:with:colons");
    expect(creds.username).toBe("admin");
    expect(creds.password).toBe("pass:with:colons");
  });

  it("parses line1=user line2=password", () => {
    const creds = readCredentialsFile("deploy\nTopSecret!");
    expect(creds.username).toBe("deploy");
    expect(creds.password).toBe("TopSecret!");
  });

  it("handles passwords with special characters", () => {
    const creds = readCredentialsFile("USERNAME=admin\nPASSWORD=p@$$w0rd!#%");
    expect(creds.username).toBe("admin");
    expect(creds.password).toBe("p@$$w0rd!#%");
  });

  it("skips blank lines and comments", () => {
    const creds = readCredentialsFile("\n\nadmin\n\nsecret\n\n");
    expect(creds.username).toBe("admin");
    expect(creds.password).toBe("secret");
  });

  it("returns empty for empty content", () => {
    const creds = readCredentialsFile("");
    expect(creds.username).toBeUndefined();
    expect(creds.password).toBeUndefined();
  });
});

// ─── SSH config pattern matching ─────────────────────────────────────────────

describe("SSH config host matching", () => {
  function matchHostPattern(pattern: string, host: string): boolean {
    if (pattern === "*") return false;
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
      return regex.test(host);
    }
    return pattern === host;
  }

  it("matches exact host", () => expect(matchHostPattern("prod.example.com", "prod.example.com")).toBe(true));
  it("rejects non-match", () => expect(matchHostPattern("prod.example.com", "staging.example.com")).toBe(false));
  it("matches wildcard", () => expect(matchHostPattern("*.example.com", "prod.example.com")).toBe(true));
  it("rejects wildcard-only", () => expect(matchHostPattern("*", "anything")).toBe(false));
  it("matches prefix wildcard", () => expect(matchHostPattern("prod-*", "prod-web-01")).toBe(true));
});

// ─── Auth method resolution ──────────────────────────────────────────────────

describe("auth method resolution", () => {
  function resolveAuth(entry: { key?: string; password?: string; credentialsFile?: string }): string {
    if (entry.key) return "key";
    if (entry.password) return "password";
    if (entry.credentialsFile) return "credentials-file";
    return "agent";
  }

  it("prefers key over password", () => {
    expect(resolveAuth({ key: "/path/to/key", password: "pass" })).toBe("key");
  });

  it("uses password when no key", () => {
    expect(resolveAuth({ password: "pass" })).toBe("password");
  });

  it("uses credentials file", () => {
    expect(resolveAuth({ credentialsFile: "/path/to/creds" })).toBe("credentials-file");
  });

  it("falls back to agent", () => {
    expect(resolveAuth({})).toBe("agent");
  });
});

// ─── Docker exec command ─────────────────────────────────────────────────────

describe("Docker exec command construction", () => {
  function buildDockerExecCmd(container: string, command: string): string {
    return `docker exec ${container} sh -c ${JSON.stringify(command)}`;
  }

  it("builds basic docker exec", () => {
    expect(buildDockerExecCmd("myapp", "ls -la")).toBe('docker exec myapp sh -c "ls -la"');
  });

  it("handles pipe commands", () => {
    const cmd = buildDockerExecCmd("nginx", "cat /etc/nginx/nginx.conf | grep server");
    expect(cmd).toContain("docker exec nginx");
    expect(cmd).toContain("cat /etc/nginx/nginx.conf | grep server");
  });
});

// ─── Error enhancement ───────────────────────────────────────────────────────

describe("SSH error messages", () => {
  function enhanceMsg(errMsg: string, host: string): string {
    if (errMsg.includes("Authentication failed")) return `SSH auth failed for ${host}`;
    if (errMsg.includes("ECONNREFUSED")) return `Connection refused by ${host}`;
    if (errMsg.includes("ETIMEDOUT")) return `Cannot reach ${host}`;
    if (errMsg.includes("ENOTFOUND")) return `Cannot reach ${host}`;
    return errMsg;
  }

  it("enhances auth failure", () => {
    expect(enhanceMsg("Authentication failed", "prod")).toContain("auth failed");
  });

  it("enhances connection refused", () => {
    expect(enhanceMsg("ECONNREFUSED", "prod")).toContain("Connection refused");
  });

  it("enhances timeout", () => {
    expect(enhanceMsg("ETIMEDOUT", "prod")).toContain("Cannot reach");
  });

  it("enhances DNS failure", () => {
    expect(enhanceMsg("ENOTFOUND", "badhost")).toContain("Cannot reach");
  });

  it("passes through unknown errors", () => {
    expect(enhanceMsg("Something else", "host")).toBe("Something else");
  });
});
