import { spawn } from 'child_process';
import { McpOAuth } from '../mcp/oauth';
import { FileSecretStorage } from '../providers/secrets';

/** The command that opens a URL in the system browser. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  // rundll32 takes the URL as one argument; `cmd /c start` would split it at every "&".
  return platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
}

/** Opens a URL in the system browser and prints it too, for a terminal with no browser (SSH). */
export async function openInBrowser(url: string, write: (s: string) => void = (s) => process.stderr.write(s)): Promise<boolean> {
  write(`Opening your browser to sign in. If it does not open, visit:\n  ${url}\n`);
  const [bin, args] = browserCommand(url);
  return new Promise((resolve) => {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/** OAuth for remote MCP servers in the CLI: tokens in `~/.localpilot/secrets.json` (0600), sign-in in the system browser. */
export function cliMcpOAuth(log?: (m: string) => void, store = new FileSecretStorage()): McpOAuth {
  return new McpOAuth(store, { openExternal: (url) => openInBrowser(url), log });
}
