/**
 * /etc/shadow parser.
 *
 * Format: username:password:lastchanged:min:max:warn:inactive:expire:reserved
 *
 * SECURITY: Never log or store actual password hashes.
 * This parser only extracts metadata, not the hash itself.
 */

export interface ShadowEntry {
  username: string;
  hasPassword: boolean;
  locked: boolean;
  /** Days since epoch of last password change */
  lastChanged: number | null;
  minDays: number | null;
  maxDays: number | null;
  warnDays: number | null;
  inactiveDays: number | null;
  expireDate: number | null;
  /** Password hash algorithm (1=MD5, 5=SHA256, 6=SHA512, y=yescrypt) */
  algorithm: string | null;
}

export function parseShadow(content: string): ShadowEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const parts = line.split(":");
      if (parts.length < 2) return null;

      const passwordField = parts[1] ?? "";
      const locked = passwordField.startsWith("!") || passwordField.startsWith("*");
      const hasPassword = passwordField.length > 1 && !locked && passwordField !== "!!" && passwordField !== "";

      // Extract algorithm from $id$salt$hash format
      let algorithm: string | null = null;
      if (passwordField.startsWith("$")) {
        const algoMatch = passwordField.match(/^\$(\w+)\$/);
        if (algoMatch) {
          const algoMap: Record<string, string> = {
            "1": "MD5",
            "5": "SHA-256",
            "6": "SHA-512",
            "y": "yescrypt",
            "2a": "bcrypt",
            "2b": "bcrypt",
          };
          algorithm = algoMap[algoMatch[1]] ?? algoMatch[1];
        }
      }

      return {
        username: parts[0],
        hasPassword,
        locked,
        lastChanged: parts[2] ? Number(parts[2]) || null : null,
        minDays: parts[3] ? Number(parts[3]) || null : null,
        maxDays: parts[4] ? Number(parts[4]) || null : null,
        warnDays: parts[5] ? Number(parts[5]) || null : null,
        inactiveDays: parts[6] ? Number(parts[6]) || null : null,
        expireDate: parts[7] ? Number(parts[7]) || null : null,
        algorithm,
      };
    })
    .filter((e): e is ShadowEntry => e !== null);
}
