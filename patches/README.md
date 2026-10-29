# MCP vendor patches

## `warden-mcp-getpassword-sync.patch`

Upstream: [@icoretech/warden-mcp](https://github.com/icoretech/warden-mcp) (`keychain_get_password` / `KeychainSdk.getPassword`).

**Problem:** After a vault password change, `bw get password <search term>` can return a stale value while `bw sync` + `bw get item <id>` reflects the current login password. Cloud agents saw RemoteControl auth failures when using term-based password reads.

**Fix:** In `getPassword`, run `bw sync` before reads; when the term is a Bitwarden item id (UUID), read the password from `get item` JSON instead of `get password`.

Apply on a matching upstream tag (tested against **0.2.60**):

```bash
curl -sL https://github.com/icoretech/warden-mcp/archive/refs/tags/v0.2.60.tar.gz | tar xz
cd warden-mcp-0.2.60
patch -p1 < /path/to/warden-mcp-getpassword-sync.patch
npm run build
```

Until upstream merges, pin cloud Warden MCP to a build that includes this patch.
