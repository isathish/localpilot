import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ChatController } from './chatController';
import { ALL_MODES, Session } from '../types';

const EXT_ID = 'localpilot.localpilot-agent';

/**
 * `localpilot` terminal command. The shell shim forwards the prompt to VS Code through a
 * `vscode://localpilot.localpilot-agent/run?...` URI, so `localpilot "fix the failing tests"`
 * opens LocalPilot in the current workspace and starts an agent — like the `cursor`/`claude` CLIs.
 * Also handles `/new`, `/settings?section=…`, `/setup` and `/terminal?run=…` deep links (`localpilot --settings`, `localpilot --setup`).
 */
export function registerUriHandler(ctx: vscode.ExtensionContext, controller: ChatController, reveal: () => void): void {
  ctx.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        // `uri.query` is already percent-decoded by VS Code; parse it ourselves so '+' and '%' in prompts survive.
        const params = new Map<string, string>();
        for (const part of uri.query.split('&')) {
          const eq = part.indexOf('=');
          if (eq > 0) {
            params.set(part.slice(0, eq), part.slice(eq + 1));
          }
        }
        const prompt = (params.get('prompt') ?? '').trim();
        const mode = ((ALL_MODES as readonly string[]).includes(params.get('mode') ?? '') ? params.get('mode') : 'agent') as Session['mode'];
        const files = (params.get('files') ?? '').split(',').map((f) => f.trim()).filter(Boolean);
        reveal();
        if (uri.path === '/run' && prompt) {
          const parallel = params.get('parallel') === '1';
          if (parallel) {
            await controller.runParallel(prompt.split('|').map((t) => t.trim()).filter(Boolean), mode);
          } else {
            await controller.runPrompt(prompt, mode, files);
          }
        } else if (uri.path === '/new') {
          await controller.handle({ type: 'newSession', mode });
        } else if (uri.path === '/settings') {
          // vscode://localpilot.localpilot-agent/settings?section=providers
          await vscode.commands.executeCommand('localpilot.openSettings', params.get('section') ?? undefined);
        } else if (uri.path === '/setup') {
          await vscode.commands.executeCommand('localpilot.openWelcome');
        } else if (uri.path === '/terminal') {
          // vscode://localpilot.localpilot-agent/terminal?run=localpilot%20--help — open the LocalPilot terminal, optionally running a command.
          await vscode.commands.executeCommand('localpilot.openTerminal', params.get('run') ?? undefined);
        }
      },
    })
  );
}

/** Shell shim + env for the `localpilot` command. Exported so the LocalPilot terminal profile can put it on PATH without installing. */
export function cliShim(ctx: vscode.ExtensionContext): { posix: string; windows: string; env: Record<string, string> } {
  const codeBin = detectCodeBinary();
  const cliJs = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'cli.js').fsPath;
  const electron = process.execPath; // the extension host binary runs plain Node when ELECTRON_RUN_AS_NODE=1
  const posix = `#!/usr/bin/env bash
# LocalPilot CLI — the LocalPilot coding agent in your terminal. \`localpilot --help\` for usage.
# Runs dist/cli.js from the installed LocalPilot extension with node (or VS Code's bundled runtime).
set -eu
CLI="\${LOCALPILOT_CLI:-}"
if [ -z "$CLI" ] || [ ! -f "$CLI" ]; then
  CLI="${cliJs}"
  if [ ! -f "$CLI" ]; then
    # Extension was updated: pick the newest installed LocalPilot version.
    for d in "$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions" "$HOME/.vscode-oss/extensions" "$HOME/.vscodium/extensions"; do
      [ -d "$d" ] || continue
      c=$(ls -d "$d"/${EXT_ID}-* 2>/dev/null | sort -V | tail -n1)
      if [ -n "$c" ] && [ -f "$c/dist/cli.js" ]; then CLI="$c/dist/cli.js"; break; fi
    done
  fi
fi
[ -f "$CLI" ] || { echo "localpilot: cannot find the LocalPilot extension (dist/cli.js). Reinstall from the VS Code Marketplace." >&2; exit 1; }
export LOCALPILOT_CODE_BIN="\${LOCALPILOT_CODE_BIN:-${codeBin}}"
if command -v node >/dev/null 2>&1; then
  exec node "$CLI" "$@"
fi
export ELECTRON_RUN_AS_NODE=1
exec "${electron}" "$CLI" "$@"
`;
  const windows = `@echo off\r
rem LocalPilot CLI — the LocalPilot coding agent in your terminal. localpilot --help for usage.\r
setlocal\r
set "CLI=%LOCALPILOT_CLI%"\r
if not exist "%CLI%" set "CLI=${cliJs.replace(/\\/g, '\\\\')}"\r
if not exist "%CLI%" for /f "delims=" %%D in ('dir /b /ad /o-n "%USERPROFILE%\\.vscode\\extensions\\${EXT_ID}-*" 2^>nul') do if not defined FOUND if exist "%USERPROFILE%\\.vscode\\extensions\\%%D\\dist\\cli.js" ( set "CLI=%USERPROFILE%\\.vscode\\extensions\\%%D\\dist\\cli.js" & set FOUND=1 )\r
if not exist "%CLI%" ( echo localpilot: cannot find the LocalPilot extension ^(dist\\cli.js^). Reinstall from the VS Code Marketplace. 1>&2 & exit /b 1 )\r
if not defined LOCALPILOT_CODE_BIN set "LOCALPILOT_CODE_BIN=${codeBin.replace(/\\/g, '\\\\')}"\r
where node >nul 2>nul && ( node "%CLI%" %* & exit /b %ERRORLEVEL% )\r
set ELECTRON_RUN_AS_NODE=1\r
"${electron.replace(/\\/g, '\\\\')}" "%CLI%" %*\r
`;
  return { posix, windows, env: { LOCALPILOT_CLI: cliJs, LOCALPILOT_CODE_BIN: codeBin } };
}

/** Writes the `localpilot` shim into ~/.local/bin (or %USERPROFILE%\bin on Windows) and explains PATH setup. */
export async function installCli(ctx: vscode.ExtensionContext): Promise<void> {
  const { posix, windows } = cliShim(ctx);
  const home = os.homedir();
  if (process.platform === 'win32') {
    const dir = path.join(home, 'bin');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'localpilot.cmd');
    await fs.writeFile(file, windows);
    const pick = await vscode.window.showInformationMessage(`Installed ${file}. Add ${dir} to your PATH, then run: localpilot "describe a task"`, 'Open LocalPilot terminal');
    if (pick) {
      await vscode.commands.executeCommand('localpilot.openTerminal');
    }
    return;
  }
  const dir = path.join(home, '.local', 'bin');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'localpilot');
  await fs.writeFile(file, posix, { mode: 0o755 });
  const onPath = (process.env.PATH ?? '').split(':').includes(dir);
  const msg = `Installed ${file}.${onPath ? '' : ` Add it to your PATH: export PATH="$HOME/.local/bin:$PATH"`} Try: localpilot "add tests for src/utils.ts"`;
  const pick = await vscode.window.showInformationMessage(msg, 'Open LocalPilot terminal');
  if (pick) {
    await vscode.commands.executeCommand('localpilot.openTerminal');
  }
}

function detectCodeBinary(): string {
  // Prefer the running app's bundled CLI so the shim works even when `code` is not on PATH.
  const appRoot = vscode.env.appRoot;
  if (process.platform === 'darwin') {
    const m = /^(.*\.app)\/Contents\/Resources\/app$/.exec(appRoot);
    if (m) {
      return `${m[1]}/Contents/Resources/app/bin/code`;
    }
  }
  if (process.platform === 'win32') {
    return path.join(appRoot, 'bin', 'code.cmd');
  }
  return path.join(appRoot, 'bin', 'code');
}
