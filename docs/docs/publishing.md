---
title: Publishing to the Marketplace
description: One-time publisher setup, then publish LocalPilot to the VS Code Marketplace and Open VSX from CI or from your own machine.
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

Then use either route:

- **Publish an existing release.** Run *Actions → Publish to Marketplace → Run workflow*. Enter the release tag (empty means the latest release) and pick `marketplace`, `openvsx` or `both`. The workflow downloads that release's `localpilot-X.Y.Z.vsix`, checks it against `SHA256SUMS.txt`, confirms the `localpilot` publisher exists, and publishes. It does not rebuild anything.
- **Cut a new release.** Push releasable commits to `main`. The **Release** workflow bumps the version, tests, tags, creates the GitHub Release and publishes to both stores. A store whose secret is missing is skipped with a warning; add the secret and run **Publish to Marketplace** for that tag. To choose the version yourself, use *Actions → Prepare release → Run workflow* or `npm run release -- minor` locally. See [Development → Releases]({{ '/docs/development/#releases' | relative_url }}).

## Path B — publish from your machine

```bash
npx @vscode/vsce login localpilot      # paste the token once; stored in the OS keychain
npx @vscode/vsce publish --no-dependencies --packagePath localpilot-X.Y.Z.vsix
```

`vsce publish` without `--packagePath` builds and publishes the current working tree instead. CI packages with `--readme-path MARKETPLACE.md`, so add that flag if you build locally and want the same listing text.

For Open VSX:

```bash
npx ovsx publish localpilot-X.Y.Z.vsix -p <your Open VSX token>
```

## Verify

- Marketplace listing: <https://marketplace.visualstudio.com/items?itemName=localpilot.localpilot-agent>
- `code --install-extension localpilot.localpilot-agent`
- Open VSX listing, after the first Open VSX publish: <https://open-vsx.org/extension/localpilot/localpilot-agent> (LocalPilot is not on Open VSX yet)
- The listing text comes from `MARKETPLACE.md` (packaged as the README with `--readme-path`), plus `CHANGELOG.md`, the `media/logo.png` icon and the `galleryBanner` colour from `package.json`.

## Troubleshooting

| Error | Fix |
|---|---|
| `Access Denied` / 401 | Token lacks *Marketplace → Manage* or is scoped to one organization |
| `Publisher 'localpilot' not found`, or the workflow's *Publisher missing* error | Create the publisher first, or change `publisher` in `package.json` |
| `Extension 'localpilot' already exists` with a different owner | The ID is taken; pick a new `name`/`publisher` |
| README images rejected | Only HTTPS images from trusted hosts; relative paths are rewritten to the GitHub repository automatically |
