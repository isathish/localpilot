import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { addMcpFileServer, catalogSecretName, catalogServerConfig, fetchMcpRegistry, freeServerName, loadMcpCatalog, McpCatalogEntry } from '../mcp/catalog';
import { userMcpFile } from '../mcp/config';
import type { ProviderSecrets } from '../providers/secrets';

/** The bundled catalog and, after an explicit refresh, the MCP registry's servers (kept for this window). */
export class McpCatalogService {
  private registry: McpCatalogEntry[] = [];
  private registryError?: string;

  constructor(private readonly extensionUri: vscode.Uri, private readonly log: vscode.LogOutputChannel) {}

  async entries(): Promise<{ entries: McpCatalogEntry[]; registry: boolean; error?: string }> {
    const { entries, problems } = await loadMcpCatalog(vscode.Uri.joinPath(this.extensionUri, 'media', 'mcp-catalog.json').fsPath);
    if (problems.length) {
      this.log.warn(`MCP catalog: ${problems.join('; ')}`);
    }
    const ids = new Set(entries.map((e) => e.id));
    return { entries: [...entries, ...this.registry.filter((e) => !ids.has(e.id))], registry: this.registry.length > 0, error: this.registryError };
  }

  /** Fetches the MCP registry; only ever on the user's request. */
  async refreshRegistry(): Promise<void> {
    try {
      this.registry = await fetchMcpRegistry();
      this.registryError = undefined;
      this.log.info(`MCP registry: ${this.registry.length} servers`);
    } catch (e) {
      this.registryError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async find(id: string): Promise<McpCatalogEntry | undefined> {
    return (await this.entries()).entries.find((e) => e.id === id);
  }
}

/**
 * Installs a catalog server into the user's `mcp.json`: asks local or remote (when both exist), a free name, and the
 * values of its variables. Secret values go to the OS keychain and the file gets `${secret:…}` references.
 * Resolves the name written, or undefined when the user cancelled.
 */
export async function installCatalogServer(entry: McpCatalogEntry, taken: string[], secrets: ProviderSecrets | undefined, file = userMcpFile()): Promise<string | undefined> {
  let how: 'local' | 'remote' = entry.install ? 'local' : 'remote';
  if (entry.install && entry.remote) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Run it on this machine', description: [entry.install.command, ...entry.install.args].join(' '), how: 'local' as const },
        { label: 'Connect to the hosted server', description: entry.remote.url, detail: 'You may be asked to sign in when it first connects.', how: 'remote' as const },
      ],
      { title: `Install ${entry.name}` }
    );
    if (!pick) {
      return undefined;
    }
    how = pick.how;
  }
  const name = freeServerName(entry.id, taken);
  const values: Record<string, string> = {};
  if (how === 'local') {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    for (const v of entry.install?.env ?? []) {
      if (!v.required) {
        continue;
      }
      const secret = v.secret !== false;
      const value = await vscode.window.showInputBox({
        title: `${entry.name}: ${v.name}`,
        prompt: `${v.description ?? v.name}${v.url ? ` — get one at ${v.url}` : ''}${secret ? '. Stored in your OS keychain, not in mcp.json.' : ''}`,
        value: v.default?.replace(/\$\{workspaceFolder\}/g, folder),
        password: secret,
        ignoreFocusOut: true,
        validateInput: (s) => (s.trim() ? undefined : `${v.name} is required`),
      });
      if (value === undefined) {
        return undefined;
      }
      const clean = value.trim();
      if (secret && secrets) {
        values[v.name] = await secrets.storeUnowned(catalogSecretName(name, v.name), clean);
      } else {
        values[v.name] = secret ? `\${env:${v.name}}` : clean;
        if (secret) {
          void vscode.window.showWarningMessage(`No secret storage here: ${v.name} is read from the environment variable of that name.`);
        }
      }
    }
  }
  const cfg = catalogServerConfig(entry, how, values);
  await addMcpFileServer(file, name, cfg);
  return name;
}

/** Shown after an install: where it went. */
export function installedMessage(name: string, file = userMcpFile()): string {
  return `Added the MCP server “${name}” to ${file.startsWith(os.homedir()) ? `~${path.sep}${path.relative(os.homedir(), file)}` : file}; it starts now.`;
}
