---
title: Publishing to the Marketplace
description: One-time publisher setup and the two supported publish paths (CI or local).
permalink: /docs/publishing/
---

## One-time setup

1. **Create a publisher** at <https://marketplace.visualstudio.com/manage/createpublisher> with ID `localpilot` (must match `publisher` in `package.json`). Sign in with a Microsoft account.
2. **Create a Personal Access Token** in Azure DevOps: <https://dev.azure.com> → *User settings → Personal access tokens → New Token*
   - Organization: **All accessible organizations**
   - Scopes: *Custom defined* → **Marketplace → Manage**
   - Expiry: up to one year; rotate before it expires.
3. Optionally create an [Open VSX](https://open-vsx.org) access token for VSCodium / Cursor users.

> Treat these tokens like passwords. Enter them only in a terminal or the GitHub secrets UI.

## Path A — publish from CI (recommended)

```bash
gh secret set VSCE_PAT --repo isathish/localpilot     # paste the Azure DevOps token
gh secret set OVSX_PAT --repo isathish/localpilot     # optional
```

Then either:

- run the **Publish to Marketplace** workflow (*Actions → Publish to Marketplace → Run workflow*, choose the release tag), which downloads the already-released VSIX, verifies its checksum and publishes it, or
- cut a new release: just push to `main` — the **Release** workflow bumps the version, tags, builds and publishes automatically whenever the push contains releasable commits and the secrets exist. *Actions → Prepare release → Run workflow* (or `npm run release -- minor` locally) picks a specific version. See [Development → Releases](/docs/development/#releases).

## Path B — publish from your machine

```bash
npx @vscode/vsce login localpilot      # paste the token once; stored in the OS keychain
npx @vscode/vsce publish --no-dependencies --packagePath localpilot-X.Y.Z.vsix
```

`vsce publish` without `--packagePath` builds and publishes the current working tree instead.

## Verify

- Marketplace listing: <https://marketplace.visualstudio.com/items?itemName=localpilot.localpilot-agent>
- `code --install-extension localpilot.localpilot-agent`
- The listing uses `README.md`, `CHANGELOG.md`, `media/logo.png` and the `galleryBanner` colour from `package.json`.

## Troubleshooting

| Error | Fix |
|---|---|
| `Access Denied` / 401 | Token lacks *Marketplace → Manage* or is scoped to one organization |
| `Publisher 'localpilot' not found` | Create the publisher first, or change `publisher` in `package.json` |
| `Extension 'localpilot' already exists` with a different owner | The ID is taken; pick a new `name`/`publisher` |
| README images rejected | Only HTTPS images from trusted hosts; relative paths are rewritten to the GitHub repository automatically |
