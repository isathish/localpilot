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
      <div class="flow-box"><b>Remote model endpoint</b><span>you add one in Settings → Providers</span></div>
      <div class="flow-box"><b>Web search / fetch</b><span>the agent calls them (<code>approvals.network</code>)</span></div>
      <div class="flow-box"><b>Skill index from GitHub</b><span>at most daily, if <code>skills.autoInstall</code> is on</span></div>
      <div class="flow-box"><b>Model downloads</b><span>you start one</span></div>
    </div>
  </div>
  <div class="flow-zone never">
    <div class="flow-title">Never</div>
    <p>No account, no telemetry upload, no analytics SDK and no update check in the extension.</p>
  </div>
</figure>

## What the agent can do, and what stops it

| Action | Default | Limits |
|---|---|---|
| Read files | Allowed | Confined to the open workspace folders (or the agent's worktree). A path that points outside them, through `..` or an absolute path, is refused. To give access to another folder, add it to the VS Code workspace. |
| Create and edit files | Allowed (`approvals.write: always`) | Same confinement. Every edit is snapshotted first; in a git repo the agent works in its own worktree and nothing reaches your workspace until you click **Apply**. |
| Delete files | Asks (`approvals.delete: ask`) | Same confinement. |
| Run commands | Asks (`approvals.terminal: ask`) | Commands run in a real shell **as your user**, so they are not confined to the workspace. This is the main thing to approve carefully. |
| Web search, web fetch, MCP tools | Allowed (`approvals.network: always`) | Set `ask` to approve each call or `never` to block them. |

Set each policy to `always`, `ask` or `never` in **Settings → Agent & approvals**, or pick the *Careful*, *Balanced* or *Autonomous* preset. You can add finer rules in `.localpilot/settings.json` or `.claude/settings.json`, in Claude Code's format: for example, `"deny": ["Read(.env)", "Bash(rm *)"]`. A `deny` rule always wins over `ask` and `allow`.

## Trust boundaries

These are the places where text or code from someone else can influence the agent. Each one is a decision you make.

**Untrusted repositories.** A project can contain `.claude/settings.json` or `.localpilot/settings.json` files that allow commands without asking, and hooks that run shell commands when a session starts or a tool runs. In VS Code, LocalPilot does not run in **Restricted Mode**, so opening a repository you don't trust in Restricted Mode keeps it switched off. The `localpilot` CLI has no Restricted Mode: only run it in projects you trust, or set `localpilot.hooks.enabled` to `false`.

**Prompt injection.** Files, web pages, tool output and MCP results can contain instructions aimed at the model. A local model is not better at ignoring them than a cloud model. The approvals above are the safety net: keep `approvals.terminal` on `ask` when the agent reads content you didn't write.

**Skills.** A skill is a Markdown file of instructions the model follows. Skills installed automatically from the repositories in `localpilot.skills.repositories` are third-party text. Set `localpilot.skills.autoInstall` to `ask` to review each one, or `off`.

**MCP servers.** Each server is a program you configure. It runs with your user account and inherits your environment variables. Add only servers you would run yourself, and set `approvals.network` to `ask` to see each tool call.

**Secrets.** Provider API keys and the web search key are stored in your VS Code settings file as plain text, the same as other VS Code settings. Local servers usually need no key. If you turn on Redis storage for metrics, keep Redis on `127.0.0.1` or protect it with a password.

## Isolation with git worktrees

With `localpilot.worktrees.mode` set to `always` (the default) in a git repository, each chat edits a separate worktree under `~/.localpilot/worktrees`. Your working copy and open editors stay untouched until you review the diff and apply it. Commands the agent runs start in the worktree, but they are not sandboxed: a command can still write anywhere your user can.

## Reporting a vulnerability

Please report security problems privately through [GitHub security advisories]({{ site.repo }}/security/advisories/new) rather than in a public issue. Include the LocalPilot version, your OS, and steps to reproduce. You will get an acknowledgement, and the fix will be credited in the [changelog]({{ site.repo }}/blob/main/CHANGELOG.md) unless you prefer otherwise.

Non-sensitive bugs go to [GitHub issues]({{ site.repo }}/issues).
