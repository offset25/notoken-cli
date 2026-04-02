import { describe, it, expect } from "vitest";
import { parseZoneFile } from "../../../src/parsers/bindParser.js";

const SAMPLE_ZONE = `$TTL 86400
$ORIGIN example.com.
@   IN  SOA  ns1.example.com. admin.example.com. (
        2024010101  ; serial
        3600        ; refresh
        900         ; retry
        1209600     ; expire
        86400       ; minimum
)

        IN  NS   ns1.example.com.
        IN  NS   ns2.example.com.

        IN  A    93.184.216.34
        IN  AAAA 2606:2800:220:1:248:1893:25c8:1946

www     IN  A    93.184.216.34
mail    IN  A    93.184.216.35
        IN  MX   10 mail.example.com.
        IN  MX   20 mail2.example.com.
        IN  TXT  "v=spf1 include:_spf.example.com ~all"
ftp     IN  CNAME www.example.com.`;

describe("BIND zone file parser", () => {
  it("parses $TTL", () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    expect(zone.defaultTTL).toBe(86400);
  });

  it("parses $ORIGIN", () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    expect(zone.origin).toBe("example.com.");
  });

  it("parses SOA record", () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    expect(zone.soa).toBeDefined();
    expect(zone.soa!.primaryNS).toBe("ns1.example.com.");
    expect(zone.soa!.serial).toBe(2024010101);
  });

  it("parses A records", () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const aRecords = zone.records.filter((r) => r.type === "A");
    expect(aRecords.length).toBeGreaterThanOrEqual(2);
  });

  it("parses MX records with priority", () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const mxRecords = zone.records.filter((r) => r.type === "MX");
    expect(mxRecords.length).toBe(2);
    expect(mxRecords[0].priority).toBe(10);
  });

  it("parses CNAME records", () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const cname = zone.records.find((r) => r.type === "CNAME");
    expect(cname).toBeDefined();
    expect(cname!.name).toBe("ftp");
  });

  it("parses NS records", () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const ns = zone.records.filter((r) => r.type === "NS");
    expect(ns.length).toBe(2);
  });

  it("parses TXT records", () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const txt = zone.records.find((r) => r.type === "TXT");
    expect(txt).toBeDefined();
    expect(txt!.data).toContain("spf1");
  });
});
