import { describe, it, expect } from "vitest";
import { parsePasswd, getLoginUsers } from "../../../packages/core/src/parsers/passwd.js";
import { parseShadow } from "../../../packages/core/src/parsers/shadow.js";
import { parseEnvFile, generateEnvName, setEnvValue } from "../../../packages/core/src/parsers/envFile.js";
import { parseNginx } from "../../../packages/core/src/parsers/nginxParser.js";
import { parseApache } from "../../../packages/core/src/parsers/apacheParser.js";
import { parseYaml, getYamlValue, listYamlPaths } from "../../../packages/core/src/parsers/yamlParser.js";
import { parseJson, searchJsonKeys } from "../../../packages/core/src/parsers/jsonParser.js";
import { detectFileType } from "../../../packages/core/src/parsers/index.js";
import { findKnownLocations } from "../../../packages/core/src/parsers/fileFinder.js";

describe("passwd parser", () => {
  const SAMPLE = `root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
deploy:x:1001:1001:Deploy User:/home/deploy:/bin/bash
nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin`;

  it("parses all entries", () => {
    const entries = parsePasswd(SAMPLE);
    expect(entries).toHaveLength(4);
  });

  it("extracts user fields correctly", () => {
    const entries = parsePasswd(SAMPLE);
    const root = entries[0];
    expect(root.username).toBe("root");
    expect(root.uid).toBe(0);
    expect(root.home).toBe("/root");
    expect(root.shell).toBe("/bin/bash");
  });

  it("identifies login users", () => {
    const entries = parsePasswd(SAMPLE);
    const login = getLoginUsers(entries);
    expect(login.map((u) => u.username)).toContain("deploy");
    expect(login.map((u) => u.username)).not.toContain("daemon");
  });
});

describe("shadow parser", () => {
  const SAMPLE = `root:$6$abc123$hash:19000:0:99999:7:::
deploy:$y$salt$hash:19500:0:99999:7:::
locked:!:18000:0:99999:7:::
nopass:!!:18000:0:99999:7:::`;

  it("parses entries", () => {
    const entries = parseShadow(SAMPLE);
    expect(entries).toHaveLength(4);
  });

  it("detects password algorithms", () => {
    const entries = parseShadow(SAMPLE);
    expect(entries[0].algorithm).toBe("SHA-512");
    expect(entries[1].algorithm).toBe("yescrypt");
  });

  it("detects locked accounts", () => {
    const entries = parseShadow(SAMPLE);
    expect(entries[2].locked).toBe(true);
    expect(entries[0].locked).toBe(false);
  });
});

describe("env parser", () => {
  const SAMPLE = `# Database
DB_HOST=localhost
DB_PORT=5432
DB_PASSWORD=supersecret
API_KEY="sk-abc123"
# Comment line
NODE_ENV=production`;

  it("parses key-value pairs", () => {
    const entries = parseEnvFile(SAMPLE);
    expect(entries).toHaveLength(5);
    expect(entries[0].key).toBe("DB_HOST");
    expect(entries[0].value).toBe("localhost");
  });

  it("strips quotes from values", () => {
    const entries = parseEnvFile(SAMPLE);
    const apiKey = entries.find((e) => e.key === "API_KEY");
    expect(apiKey?.value).toBe("sk-abc123");
  });

  it("flags secret keys", () => {
    const entries = parseEnvFile(SAMPLE);
    expect(entries.find((e) => e.key === "DB_PASSWORD")?.isSecret).toBe(true);
    expect(entries.find((e) => e.key === "API_KEY")?.isSecret).toBe(true);
    expect(entries.find((e) => e.key === "DB_HOST")?.isSecret).toBe(false);
  });
});

describe("generateEnvName", () => {
  it("generates DB_STAGING_PASSWORD", () => {
    expect(generateEnvName("database", "password", "staging")).toBe("DB_STAGING_PASSWORD");
  });

  it("generates API_PROD_KEY", () => {
    expect(generateEnvName("api", "key", "prod")).toBe("API_PROD_KEY");
  });

  it("generates REDIS_URL without environment", () => {
    expect(generateEnvName("redis", "url")).toBe("REDIS_URL");
  });

  it("generates SMTP_PROD_PASSWORD", () => {
    expect(generateEnvName("smtp", "password", "production")).toBe("SMTP_PROD_PASSWORD");
  });

  it("handles unknown topics", () => {
    expect(generateEnvName("myservice", "token", "dev")).toBe("MYSERVICE_DEV_TOKEN");
  });
});

describe("setEnvValue", () => {
  it("updates existing key", () => {
    const result = setEnvValue("FOO=bar\nBAZ=qux", "FOO", "new");
    expect(result).toContain("FOO=new");
    expect(result).toContain("BAZ=qux");
  });

  it("appends new key", () => {
    const result = setEnvValue("FOO=bar", "NEW", "value");
    expect(result).toContain("FOO=bar");
    expect(result).toContain("NEW=value");
  });
});

describe("nginx parser", () => {
  const SAMPLE = `
server {
    listen 80;
    server_name example.com;
    root /var/www/html;

    location / {
        try_files $uri $uri/ =404;
    }

    location /api {
        proxy_pass http://localhost:3000;
    }
}`;

  it("extracts server blocks", () => {
    const config = parseNginx(SAMPLE);
    expect(config.servers).toHaveLength(1);
  });

  it("extracts server_name", () => {
    const server = parseNginx(SAMPLE).servers[0];
    expect(server.serverName).toContain("example.com");
  });

  it("extracts locations with proxy_pass", () => {
    const server = parseNginx(SAMPLE).servers[0];
    const apiLoc = server.locations.find((l) => l.path === "/api");
    expect(apiLoc?.proxyPass).toBe("http://localhost:3000");
  });
});

describe("apache parser", () => {
  const SAMPLE = `
<VirtualHost *:80>
    ServerName example.com
    DocumentRoot /var/www/html
    ErrorLog /var/log/apache2/error.log
</VirtualHost>`;

  it("extracts VirtualHost blocks", () => {
    const config = parseApache(SAMPLE);
    expect(config.vhosts).toHaveLength(1);
  });

  it("extracts ServerName", () => {
    expect(parseApache(SAMPLE).vhosts[0].serverName).toBe("example.com");
  });

  it("extracts DocumentRoot", () => {
    expect(parseApache(SAMPLE).vhosts[0].documentRoot).toBe("/var/www/html");
  });
});

describe("yaml parser", () => {
  it("parses yaml", () => {
    const data = parseYaml("server:\n  port: 8080\n  host: localhost") as Record<string, unknown>;
    expect(data.server).toBeDefined();
  });

  it("gets nested values", () => {
    const data = parseYaml("server:\n  port: 8080");
    expect(getYamlValue(data, "server.port")).toBe(8080);
  });

  it("lists paths", () => {
    const data = parseYaml("a:\n  b: 1\n  c: 2");
    const paths = listYamlPaths(data);
    expect(paths).toContain("a.b");
    expect(paths).toContain("a.c");
  });
});

describe("json parser", () => {
  it("searches keys", () => {
    const data = parseJson('{"users": [{"name": "alice", "password": "***"}]}');
    const results = searchJsonKeys(data, "password");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toContain("password");
  });
});

describe("detectFileType", () => {
  it("detects passwd", () => expect(detectFileType("/etc/passwd")).toBe("passwd"));
  it("detects shadow", () => expect(detectFileType("/etc/shadow")).toBe("shadow"));
  it("detects .env", () => expect(detectFileType(".env")).toBe("env"));
  it("detects yaml", () => expect(detectFileType("config.yml")).toBe("yaml"));
  it("detects json", () => expect(detectFileType("package.json")).toBe("json"));
  it("detects nginx", () => expect(detectFileType("/etc/nginx/nginx.conf")).toBe("nginx"));
  it("detects apache", () => expect(detectFileType("/etc/apache2/apache2.conf")).toBe("apache"));
});

describe("findKnownLocations", () => {
  it("finds nginx locations", () => {
    const results = findKnownLocations("nginx");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.path.includes("nginx.conf"))).toBe(true);
  });

  it("finds postgres locations", () => {
    const results = findKnownLocations("postgres");
    expect(results.length).toBeGreaterThan(0);
  });

  it("resolves aliases", () => {
    const results = findKnownLocations("httpd");
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns empty for unknown", () => {
    const results = findKnownLocations("xyznonexistent");
    expect(results).toHaveLength(0);
  });
});
