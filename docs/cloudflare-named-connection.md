# Fixed Cloudflare connection without publishing credentials

Codex with ChatGPT can use either a temporary Cloudflare address or a stable
hostname under a domain already managed by Cloudflare. The stable option is
better for a long-lived ChatGPT App because ordinary computer restarts do not
change its server address.

## What belongs in Git

Commit only the reusable implementation and documentation:

- named-connection source code and tests;
- generic setup and recovery instructions;
- example hostnames such as `c2c-<workspace>.example.com`;
- security properties and expected behavior.

Do not commit:

- Cloudflare account certificates or tunnel credential JSON files;
- API tokens, tunnel tokens, OAuth tokens, pairing codes, or cookies;
- real private hostnames when their disclosure is undesirable;
- generated runtime state, logs, or workspace session files.

Codex with ChatGPT stores its runtime connection state in the operating-system
application-data directory, outside the source repository. Cloudflared also
stores its login and tunnel credentials outside the repository. A normal
`git clone`, `git pull`, or `git push` therefore does not transfer them.

## Set up another computer

1. Clone the repository and install/build Codex with ChatGPT.
2. Install `cloudflared` on that computer.
3. Run the normal C2C setup for the target workspace.
4. Choose the fixed-domain option and authenticate to Cloudflare interactively.
5. Use a hostname dedicated to that computer or workspace, for example
   `c2c-<workspace>-<machine>.example.com`.
6. Create or reconnect the matching ChatGPT App using the generated address and
   complete one-time pairing.

Using a distinct hostname per simultaneously active machine avoids two
connectors competing for the same DNS route. Reusing one hostname is reasonable
only when one machine is active at a time and the same named-tunnel credentials
are provisioned securely outside Git.

## Safe recovery

After a restart, run `c2c doctor -w <workspace> --json`. A healthy named
connection reuses its stable hostname. If Cloudflare authorization has expired,
log in again through the interactive flow. Do not copy credentials into a
project file or ChatGPT prompt.

Publishing the general method is safe. The public hostname itself is not an
authentication credential because the endpoint still requires authorization,
but omitting the real hostname from public documentation reduces unnecessary
exposure.
