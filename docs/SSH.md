# SSH — Remote Connections, Key Management, and File Transfer

Notoken uses the `ssh2` npm package (pure Node.js) for all remote operations. No system SSH binary, `sshpass`, or `expect` is required — password auth, key auth, agent forwarding, and ProxyJump all work out of the box.

## Quick Reference

| Command | What it does |
|---------|-------------|
| `ssh test prod` | Test SSH connectivity to a host |
| `add ssh login for prod user root password xyz` | Store credentials (encrypted) |
| `generate ssh key for prod` | Generate ed25519 key pair |
| `copy ssh key to prod` | Copy public key to remote authorized_keys |
| `copy ssh key to prod via bastion` | Copy key through a jump host |
| `show ssh credentials` | List stored logins, keys, and config |
| `show ssh config` | List ~/.ssh/config entries |
| `add ssh config for prod` | Add host to ~/.ssh/config |
| `add ssh config for prod via bastion` | Add with ProxyJump |
| `remove ssh login for prod` | Delete stored credentials |
| `set ssh passphrase` | Set master passphrase for vault encryption |

## Architecture

```
packages/core/src/execution/ssh.ts        — ssh2 connections, exec, SFTP
packages/core/src/utils/sshCredentials.ts  — vault, key mgmt, config mgmt
packages/core/config/hosts.json            — host definitions (optional)
~/.notoken/ssh-vault.json                  — encrypted credential vault
~/.ssh/config                              — standard SSH config (read/write)
~/.ssh/notoken_*                           — generated key pairs
```

## Connection Flow

```
User: "restart nginx on prod"
  │
  ├─ resolveHostConfig(entry)
  │   ├─ Read ~/.ssh/config for host alias
  │   ├─ Find key: explicit > ssh config > ~/.ssh/id_ed25519 > id_rsa > id_ecdsa
  │   ├─ Read credentials file if specified
  │   └─ Detect ProxyJump / ProxyCommand
  │
  ├─ ProxyJump configured?
  │   ├─ YES → connectViaProxy() — chain through bastion(s)
  │   └─ NO  → direct ssh2 connect
  │
  ├─ Auth handler chain:
  │   1. publickey (if key found)
  │   2. agent (SSH_AUTH_SOCK)
  │   3. password (from vault or hosts.json)
  │
  └─ exec("systemctl restart nginx") → return output
```

## ProxyJump (Bastion/Jump Host)

Notoken supports multi-hop SSH connections through bastion hosts — same as OpenSSH's `ProxyJump` directive.

### Via ~/.ssh/config

```
Host prod
  HostName 10.0.1.50
  User deploy
  ProxyJump bastion

Host bastion
  HostName bastion.example.com
  User admin
  IdentityFile ~/.ssh/id_ed25519
```

Then just say: `restart nginx on prod` — notoken reads the config and routes through the bastion automatically.

### Via notoken commands

```bash
# Add a host with proxy
notoken "add ssh config for prod via bastion"

# Copy your key through the proxy
notoken "copy ssh key to prod via bastion"

# Store credentials with proxy
notoken "add ssh login for prod user deploy password secret via bastion"
```

### Multi-hop chains

ProxyJump supports comma-separated chains:

```
Host deep-server
  HostName 10.10.10.5
  ProxyJump bastion1,bastion2
```

This connects: local → bastion1 → bastion2 → deep-server

## Credential Vault

Passwords are encrypted at rest using AES-256-CBC with a master passphrase.

```
~/.notoken/ssh-vault.json
├── version: 1
├── masterHash: SHA-256 of passphrase (for verification)
└── credentials[]:
    ├── host, hostname, user, port
    ├── encryptedPassword, salt, iv  (AES-256-CBC)
    ├── keyPath                      (path to SSH key)
    ├── proxyJump                    (bastion host)
    └── addedAt, lastUsed, useCount
```

### Security

- Passwords encrypted with AES-256-CBC
- Default key used if no master passphrase set (warns user)
- `set ssh passphrase` to set a real master passphrase
- Key-based auth always recommended over passwords
- After `copy ssh key`, notoken suggests removing the stored password
- Password detection & redaction in chat history (never stored in conversation logs)

## SSH Key Management

### Generate

```bash
notoken "generate ssh key"           # → ~/.ssh/notoken_default_ed25519
notoken "generate ssh key for prod"  # → ~/.ssh/notoken_prod_ed25519
```

Generates ed25519 keys with no passphrase (for automated use). Keys are `chmod 600`.

### Copy to Server

```bash
notoken "copy ssh key to prod"             # Direct connection
notoken "copy ssh key to prod via bastion"  # Through jump host
```

What happens:
1. Reads your public key (~/.ssh/notoken_*.pub or id_ed25519.pub)
2. Connects to the remote host (through proxy if specified)
3. Creates `~/.ssh/` on remote if needed
4. Appends public key to `~/.ssh/authorized_keys`
5. Sets correct permissions (700/600)
6. Updates vault to use key instead of password

Falls back to `ssh-copy-id` / `sshpass` if the ssh2 approach fails.

## SFTP File Transfer

Upload and download files/directories via SFTP. Supports ProxyJump.

### Usage

```bash
notoken "copy nginx.conf to /root on prod"     # Upload
notoken "send logs/ to prod:/var/backups"       # Upload directory
notoken "download /var/log/app.log from prod"   # Download
```

### Features

- **Single files**: streamed via SFTP
- **Directories**: recursive upload/download with progress callbacks
- **ProxyJump**: SFTP tunneled through bastion hosts (same as exec)
- **Progress**: file count, bytes transferred, current file name
- **Remote mkdir**: auto-creates remote directories as needed

### How SFTP + Proxy works

```
Local ──SFTP──→ Bastion ──TCP forward──→ Target:22
                   │
            ssh2 forwardOut()
            (port forwarding)
```

The ssh2 `connectViaProxy()` function:
1. Connects to bastion via ssh2
2. Calls `forwardOut()` to open a TCP tunnel to target:22
3. Creates a new ssh2 connection over that tunnel
4. Opens SFTP session on the tunneled connection

## Host Configuration

### hosts.json (config/hosts.json)

```json
{
  "prod": {
    "host": "deploy@10.0.1.50",
    "description": "Production server",
    "port": 22,
    "key": "~/.ssh/id_ed25519"
  },
  "staging": {
    "host": "deploy@staging.example.com",
    "description": "Staging",
    "password": "staging-pass"
  }
}
```

### Entity resolver

Named entities can also be used:

```bash
notoken "metroplex is 66.94.115.165"
notoken "restart nginx on metroplex"   # Uses entity resolver
```

## Auth Method Priority

1. **Explicit key** — `key` field in hosts.json or credential vault
2. **SSH config key** — `IdentityFile` from ~/.ssh/config
3. **Default keys** — ~/.ssh/id_ed25519, id_rsa, id_ecdsa (in order)
4. **SSH agent** — SSH_AUTH_SOCK environment variable
5. **Password** — from vault (encrypted) or hosts.json

## Error Handling

| Error | What notoken tells you |
|-------|----------------------|
| Auth failed | Shows which methods were tried, suggests adding key/password |
| Connection refused | Suggests checking SSH server, port, firewall |
| Timeout / DNS | Suggests checking hostname, network connectivity |
| ProxyJump hop failed | Shows which hop failed in the chain |

## Intents

| Intent | Triggers |
|--------|----------|
| `ssh.connect` | "ssh to prod", "connect to prod" |
| `ssh.test` | "test ssh to prod", "can I reach prod" |
| `ssh.add_credential` | "add ssh login for prod user root password xyz" |
| `ssh.list_credentials` | "show ssh credentials", "list ssh logins" |
| `ssh.remove_credential` | "remove ssh login for prod" |
| `ssh.generate_key` | "generate ssh key", "create ssh key for prod" |
| `ssh.copy_key` | "copy ssh key to prod", "copy key to prod via bastion" |
| `ssh.config_add` | "add ssh config for prod", "add config via bastion" |
| `ssh.config_list` | "show ssh config" |
| `ssh.set_passphrase` | "set ssh passphrase" |

## Tests

```bash
npx vitest run tests/unit/execution/ssh.test.ts         # 36 tests
npx vitest run tests/fixtures/intents/ssh.fixture.test.ts  # 9 tests
```

Covers: credential parsing, SSH config matching, auth resolution, Docker exec, error enhancement, ProxyJump hop parsing, multi-hop chains, SFTP proxy detection, key copy command building.
