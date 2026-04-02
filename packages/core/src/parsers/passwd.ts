/**
 * /etc/passwd parser.
 *
 * Format: username:password:uid:gid:gecos:home:shell
 */

export interface PasswdEntry {
  username: string;
  hasPassword: boolean;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
  isSystem: boolean;
  isLoginUser: boolean;
}

export function parsePasswd(content: string): PasswdEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const parts = line.split(":");
      if (parts.length < 7) return null;

      const uid = Number(parts[2]);
      const shell = parts[6] ?? "";

      return {
        username: parts[0],
        hasPassword: parts[1] !== "x" && parts[1] !== "*" && parts[1] !== "!",
        uid,
        gid: Number(parts[3]),
        gecos: parts[4] ?? "",
        home: parts[5] ?? "",
        shell,
        isSystem: uid < 1000 && uid !== 0,
        isLoginUser: !shell.includes("nologin") && !shell.includes("false") && shell !== "/bin/sync",
      };
    })
    .filter((e): e is PasswdEntry => e !== null);
}

/**
 * Get only real login users (non-system, has a login shell).
 */
export function getLoginUsers(entries: PasswdEntry[]): PasswdEntry[] {
  return entries.filter((e) => e.isLoginUser && !e.isSystem);
}

/**
 * Find a user by username.
 */
export function findUser(entries: PasswdEntry[], username: string): PasswdEntry | undefined {
  return entries.find((e) => e.username === username);
}
