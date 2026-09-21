# Local Codex with ChatGPT setup

Copy this file to `LOCAL_SETUP.md` and replace every `<PLACEHOLDER>` with the
values for the current computer. `LOCAL_SETUP.md` is ignored by Git. Keep this
example file generic so it can be committed safely.

## Installation

- C2C checkout: `<ABSOLUTE_C2C_CHECKOUT_PATH>`
- Installed Skill: `<ABSOLUTE_CODEX_SKILL_PATH>`

## Workspace

- Workspace name: `<WORKSPACE_NAME>`
- Workspace root: `<ABSOLUTE_WORKSPACE_PATH>`
- Git repository: `<OWNER/REPOSITORY>`
- Git branch: `<DEFAULT_BRANCH>`

## Stable connection

- Connection mode: `named`
- Cloudflare zone: `<EXAMPLE.COM>`
- Fixed hostname: `<C2C-WORKSPACE.EXAMPLE.COM>`
- MCP URL: `https://<C2C-WORKSPACE.EXAMPLE.COM>/mcp`

Record names and addresses only. Never put a Cloudflare tunnel ID, credential
file, API token, OAuth token, pairing code, cookie, private key, or certificate
in this file.

## ChatGPT

- App/connector name: `Codex with ChatGPT · <WORKSPACE_NAME>`
- Project name: `<PROJECT_NAME>`
- Conversation mode: `project`

Keep both names stable and do not append release labels such as v4 or v5.
After adding new OAuth scopes, authorize once again; ordinary code upgrades do
not require pairing again when the hostname, App name and scopes are unchanged.

## Enabled capability profile

- Read workspace text, images, Git state and released execution output.
- Create documentation and source files; precisely update text/JSON; move files.
- Run only `test`, `build`, `lint` and `typecheck` package scripts.
- Stage explicit paths and create local commits.
- Never expose deletion, arbitrary shell, dependency installation, Git push,
  remote writes, history rewriting, sensitive files or paths outside workspace.

## How Codex should use this memory

1. Read `skill/SKILL.md` first.
2. Use the CLI from the C2C checkout above:

   ```powershell
   node "<ABSOLUTE_C2C_CHECKOUT_PATH>\bin\c2c.js" sandbox-allow --json
   node "<ABSOLUTE_C2C_CHECKOUT_PATH>\bin\c2c.js" doctor -w "<ABSOLUTE_WORKSPACE_PATH>" --json
   ```

3. Confirm `doctor` reports the fixed hostname above. If the named connection
   needs repair, follow the Skill's named-connection repair flow. Do not switch
   to a temporary address just because the fixed connection is briefly offline.
4. Reuse the exact App and Project names above. Do not create duplicates.
5. In ChatGPT, use a Chat conversation and call `workspace_info`; continue only
   after it returns the expected workspace.
6. Treat local workspace tools as the source for current and uncommitted files.
   Use `github_*` only for committed and pushed content.

## Moving to another computer

Clone the repository, copy this template to `LOCAL_SETUP.md`, and enter that
computer's paths. Cloudflare authorization and ChatGPT authorization are not
stored in Git, so run the normal setup or repair flow on the new computer.
