import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ChatController } from './chatController';

const EXT_ID = 'localpilot.localpilot-agent';

/**
 * `localpilot` terminal command. The shell shim forwards the prompt to VS Code through a
 * `vscode://localpilot.localpilot-agent/run?...` URI, so `localpilot "fix the failing tests"`
 * opens LocalPilot in the current workspace and starts an agent — like the `cursor`/`claude` CLIs.
 */
export function registerUriHandler(ctx: vscode.ExtensionContext, controller: ChatController, reveal: () => void): void {
  ctx.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        const params = new URLSearchParams(uri.query);
        const prompt = (params.get('prompt') ?? '').trim();
        const mode = (['agent', 'ask', 'plan'].includes(params.get('mode') ?? '') ? params.get('mode') : 'agent') as 'agent' | 'ask' | 'plan';
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
        }
      },
    })
  );
}

/** Writes a `localpilot` shim into ~/.local/bin (or %USERPROFILE%\bin on Windows) and explains PATH setup. */
export async function installCli(): Promise<void> {
  const codeBin = detectCodeBinary();
  const home = os.homedir();
  if (process.platform === 'win32') {
    const dir = path.join(home, 'bin');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'localpilot.cmd');
    await fs.writeFile(
      file,
      `@echo off\r\nsetlocal EnableDelayedExpansion\r\nset "MODE=agent"\r\nset "PAR="\r\n:parse\r\nif "%~1"=="" goto run\r\nif "%~1"=="--ask" (set "MODE=ask" & shift & goto parse)\r\nif "%~1"=="--plan" (set "MODE=plan" & shift & goto parse)\r\nif "%~1"=="--parallel" (set "PAR=1" & shift & goto parse)\r\nset "PROMPT=!PROMPT! %~1"\r\nshift\r\ngoto parse\r\n:run\r\nif "!PROMPT!"=="" ( "${codeBin}" --open-url "vscode://${EXT_ID}/new?mode=!MODE!" "%CD%" & exit /b )\r\nfor /f "delims=" %%E in ('powershell -NoProfile -Command "[uri]::EscapeDataString(\\"!PROMPT:~1!\\")"') do set "ENC=%%E"\r\n"${codeBin}" --open-url "vscode://${EXT_ID}/run?mode=!MODE!&parallel=!PAR!&prompt=!ENC!" "%CD%"\r\n`
    );
    void vscode.window.showInformationMessage(`Installed ${file}. Add ${dir} to your PATH, then run: localpilot "describe a task"`);
    return;
  }
  const dir = path.join(home, '.local', 'bin');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'localpilot');
  const script = `#!/usr/bin/env bash
# LocalPilot CLI — forwards a task to the LocalPilot VS Code extension in the current folder.
# Usage: localpilot [--ask|--plan] [--parallel] [--file path ...] "task description"
#        localpilot            (open a new chat)
set -euo pipefail
CODE_BIN="\${LOCALPILOT_CODE_BIN:-${codeBin}}"
MODE=agent; PAR=0; FILES=""; PROMPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ask) MODE=ask;; --plan) MODE=plan;; --agent) MODE=agent;;
    --parallel|-p) PAR=1;;
    --file|-f) shift; FILES="\${FILES:+$FILES,}$1";;
    -h|--help) sed -n '2,4p' "$0"; exit 0;;
    *) PROMPT="\${PROMPT:+$PROMPT }$1";;
  esac; shift
done
urlencode() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1" 2>/dev/null || node -e 'console.log(encodeURIComponent(process.argv[1]))' "$1"; }
if [ -z "$PROMPT" ]; then
  exec "$CODE_BIN" --open-url "vscode://${EXT_ID}/new?mode=$MODE" "$PWD"
fi
exec "$CODE_BIN" --open-url "vscode://${EXT_ID}/run?mode=$MODE&parallel=$PAR&files=$(urlencode "$FILES")&prompt=$(urlencode "$PROMPT")" "$PWD"
`;
  await fs.writeFile(file, script, { mode: 0o755 });
  const onPath = (process.env.PATH ?? '').split(':').includes(dir);
  const msg = `Installed ${file}.${onPath ? '' : ` Add it to your PATH: export PATH="$HOME/.local/bin:$PATH"`} Try: localpilot "add tests for src/utils.ts"`;
  const pick = await vscode.window.showInformationMessage(msg, 'Open in terminal');
  if (pick) {
    const t = vscode.window.createTerminal('LocalPilot CLI');
    t.show();
    t.sendText(onPath ? 'localpilot --help' : `export PATH="$HOME/.local/bin:$PATH" && localpilot --help`);
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
