# Security policy

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/isathish/localpilot/security/advisories/new), not in a public issue. Include the LocalPilot version, your OS, the model server you use and steps to reproduce.

Fixes ship in the next release and are listed in the [changelog](CHANGELOG.md). Only the latest release receives security fixes.

How the agent is limited (approvals, workspace confinement, worktrees) and where you make trust decisions (untrusted repositories, MCP servers, skills, hooks) is described at https://isathish.github.io/localpilot/security/.

## Document viewers

The PDF viewer and the Markdown reader run in webviews with a strict content security policy: only their own nonce'd scripts run, nothing loads from the network, and no `eval` is allowed (the PDF viewer adds `wasm-unsafe-eval` for pdf.js's image decoders only). In the PDF viewer, JavaScript in a document never runs (pdf.js scripting is disabled and its sandbox is not shipped), XFA is off, forms are drawn flat, embedded attachments are not exposed, and links leave the viewer only as `http`, `https` or `mailto` through VS Code; `file:`, `javascript:` and launch actions are dropped. The PDF bytes reach the viewer by message, so it cannot read any other file. Agent text extraction runs pdf.js in a separate short-lived Node process.
