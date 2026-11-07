---
layout: docs
title: Security
description: How LocalPilot limits what an AI agent can do on your machine — approvals, workspace confinement, worktree isolation, trust boundaries for MCP, skills and hooks — and how to report a vulnerability.
permalink: /security/
---

LocalPilot runs an AI agent that can read your project, edit files and run commands. This page explains what it can reach, what stops it, and where you have to make a trust decision yourself. For what data leaves your machine, see [Privacy]({{ '/privacy/' | relative_url }}).

## Where data flows

<figure class="flow" aria-label="Data-flow diagram">
  <div class="flow-zone local">
    <div class="flow-title">Your machine</div>
    <div class="flow-grid">
      <div class="flow-box core"><b>VS Code + LocalPilot</b><span>agent loop, approvals, change review</span></div>
      <div class="flow-box"><b>Model server</b><span>Ollama, LM Studio, llama.cpp… on <code>localhost</code></span></div>
      <div class="flow-box"><b>Your project</b><span>read and edited inside the workspace, or in a git worktree copy</span></div>
      <div class="flow-box"><b>Terminal</b><span>commands run as your user, approval first by default</span></div>
      <div class="flow-box"><b>Local files</b><span>chats, memory, metrics in <code>~/.localpilot</code> and <code>.localpilot/</code></span></div>
      <div class="flow-box"><b>MCP servers</b><span>local processes you configure</span></div>
    </div>
  </div>
  <div class="flow-zone remote">
    <div class="flow-title">Leaves your machine only when…</div>
    <div class="flow-grid">
      <div class="flow-box"><b>Cloud model or remote endpoint</b><span>you add one in Settings → Providers (OpenAI, Claude, Gemini, a gateway…)</span></div>
      <div class="flow-box"><b>Web search / fetch, browser tools</b><span>the agent calls them (<code>approvals.network</code>)</span></div>
      <div class="flow-box"><b>Skill index from GitHub</b><span>at most daily, if <code>skills.autoInstall</code> is on</span></div>
      <div class="flow-box"><b>Model downloads</b><span>you start one</span></div>
      <div class="flow-box"><b>OSV.dev dependency checks</b><span>a security scan sends lockfile package names and versions (<code>approvals.network</code>, <code>--offline</code>)</span></div>
      <div class="flow-box"><b>Plugin marketplaces</b><span>fetched with <code>git</code> when you browse or install plugins</span></div>
      <div class="flow-box"><b>Model gallery</b><span>ollama.com, Docker Hub and Hugging Face listings while it is open</span></div>
      <div class="flow-box"><b>Sync</b><span>you set it up: end-to-end encrypted objects to your own folder, Git repository, S3 bucket or WebDAV server</span></div>
    </div>
  </div>
  <div class="flow-zone never">
    <div class="flow-title">Never</div>
    <p>No account, no telemetry upload, no analytics SDK and no update check in the extension.</p>
  </div>
</figure>

## API keys

- A key pasted into **Settings → Providers**, or entered with *LocalPilot: Set Provider API Key…*, is stored with VS Code's `SecretStorage`, which uses the operating system's keychain. settings.json only holds `${secret:<id>}`, so settings sync, dotfile repos and screenshots of settings never contain it.
- `${env:NAME}` keys are read from the environment at use and never written anywhere.
- The Settings webview is told only whether a key resolves and where it comes from, never the key.
- Removing a provider deletes its stored key. Keys go only to that provider's own endpoint: as a Bearer token, `x-api-key` for Anthropic, or `api-key` for Azure.

## Sync encryption

Sync (off by default) is end-to-end encrypted, always:

- **Keys.** A random 256-bit data key per key id encrypts everything; it is wrapped with AES-256-GCM under a key derived from your passphrase with scrypt (N = 2^17, r = 8, p = 1, a random 16-byte salt). Only the wrapped keys and the scrypt parameters are stored on the remote (`keyring.json`); a wrong passphrase fails the GCM check and nothing is written. Devices keep the data key (never the passphrase) in VS Code's `SecretStorage` or the CLI's `~/.localpilot/keys.json` (mode 0600).
- **Objects.** Every object is AES-256-GCM with a sub-key (HKDF-SHA256) of the data key; the object's name is bound as associated data, so an object cannot be moved, swapped or replayed under another name without failing authentication. The IV is derived from the key, the name and the content, so a retried upload is byte-for-byte identical and different content never reuses an IV. Attachment names are an HMAC of their hash under another sub-key. Objects that fail authentication are skipped and reported in the Sync manager.
- **Devices and keys.** Removing a device stops listing it; **Rotate key** adds a new data key for everything uploaded afterwards, so a removed device (which knows only the old key) cannot read new data. Revoke its storage credentials at your provider too. **Change passphrase** re-wraps the keys; no data is re-encrypted.
- **Transport.** S3 requests are signed with AWS Signature Version 4; S3 and WebDAV require HTTPS (plain HTTP only for `localhost`). Git uses your own credential helper or SSH keys; LocalPilot never prompts for or stores git credentials, and refuses a repository that is a project's working tree.
- **Not covered.** The storage still sees object sizes, counts and times. Local data at rest is not encrypted by LocalPilot (use disk encryption); a forgotten passphrase cannot be recovered by anyone.

## What the agent can do, and what stops it

| Action | Default | Limits |
|---|---|---|
| Read files | Allowed | Confined to the open workspace folders (or the agent's worktree). A path that points outside them, through `..` or an absolute path, is refused. To give access to another folder, add it to the VS Code workspace. Repositories registered in `.localpilot/repos.json` or `localpilot.repos` are also in reach; entries that point at the filesystem root, your home folder or a parent of the workspace are ignored. |
| Create and edit files | Allowed (`approvals.write: always`) | Same confinement. Every edit is snapshotted first; in a git repo the agent works in its own worktree and nothing reaches your workspace until you click **Apply**. |
| Delete files | Asks (`approvals.delete: ask`) | Same confinement. |
| Run commands | Asks (`approvals.terminal: ask`) | Commands run in a real shell **as your user**, so they are not confined to the workspace. This is the main thing to approve carefully. |
| Web search, web fetch, MCP tools | Allowed (`approvals.network: always`) | Set `ask` to approve each call or `never` to block them. |

Set each policy to `always`, `ask` or `never` in **Settings → Agent & approvals**, or pick the *Careful*, *Balanced* or *Autonomous* preset. You can add finer rules in `.localpilot/settings.json` or `.claude/settings.json`, in Claude Code's format: for example, `"deny": ["Read(.env)", "Bash(rm *)"]`. A `deny` rule always wins over `ask` and `allow`.

## Trust boundaries

These are the places where text or code from someone else can influence the agent. Each one is a decision you make.

**Untrusted repositories.** A project can contain `.claude/settings.json` or `.localpilot/settings.json` files that allow commands without asking, and hooks that run shell commands when a session starts or a tool runs. In VS Code, LocalPilot does not run in **Restricted Mode**, so opening a repository you don't trust in Restricted Mode keeps it switched off. The `localpilot` CLI has no Restricted Mode: only run it in projects you trust, or set `localpilot.hooks.enabled` to `false`. `localpilot.hooks.enabled`, the `localpilot.approvals.*` policies and `localpilot.autoMode.*` are read only from your user settings or `~/.localpilot/config.json`, so a repository's `.vscode/settings.json` cannot turn hooks back on, loosen approvals or enable auto mode. A project can also start MCP servers: workspace plugins under `.claude/plugins` or `.localpilot/plugins`, a `.claude-plugin/plugin.json` at its root, or `localpilot.mcpServers` in `.vscode/settings.json`. Once the folder is trusted, and always in the CLI, these servers start without a separate prompt, and setting `localpilot.hooks.enabled` to `false` does not stop them. Disable such plugins with `enabledPlugins` in your `settings.json`, or don't run the CLI in projects you don't trust. A repository's `.localpilot/repos.json` can also extend the file tools to other folders it lists, so check it before working in a project you don't trust.

**Prompt injection.** Files, web pages, tool output and MCP results can contain instructions aimed at the model. A local model is not better at ignoring them than a cloud model. The approvals above are the safety net: keep `approvals.terminal` on `ask` when the agent reads content you didn't write.

**Skills.** A skill is a Markdown file of instructions the model follows. Skills installed automatically from the repositories in `localpilot.skills.repositories` are third-party text. Set `localpilot.skills.autoInstall` to `ask` to review each one, or `off`.

**MCP servers.** Each server is a program that you or the project configures (see *Untrusted repositories* above). It runs with your user account and inherits your environment variables. Add only servers you would run yourself, and set `approvals.network` to `ask` to see each tool call.

**Secrets.** Provider API keys, and a web search key entered in **Settings**, are kept in the operating system's keychain through VS Code's `SecretStorage`; settings.json holds only a `${secret:<id>}` reference. A key can also be read from the environment with `${env:NAME}`. A key typed directly into settings.json stays there as plain text. The CLI keeps its keys in `~/.localpilot/keys.json`, readable only by your user (or in `LOCALPILOT_KEY_<NAME>` environment variables). Local servers usually need no key. If you turn on Redis storage for metrics, keep Redis on `127.0.0.1` or protect it with a password.

## Isolation with git worktrees

With `localpilot.worktrees.mode` set to `always` (the default) in a git repository, each chat edits a separate worktree under `~/.localpilot/worktrees`. Your working copy and open editors stay untouched until you review the diff and apply it. Commands the agent runs start in the worktree, but they are not sandboxed: a command can still write anywhere your user can.

## Reporting a vulnerability

Please report security problems privately through [GitHub security advisories]({{ site.repo }}/security/advisories/new) rather than in a public issue. Include the LocalPilot version, your OS, and steps to reproduce. You will get an acknowledgement, and the fix will be credited in the [changelog]({{ site.repo }}/blob/main/CHANGELOG.md) unless you prefer otherwise.

Non-sensitive bugs go to [GitHub issues]({{ site.repo }}/issues).
