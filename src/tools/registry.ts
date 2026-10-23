import * as vscode from 'vscode';
import { Tool, ToolContext, ToolDefinition, ToolResult } from '../types';

/** Central registry of tools available to the agent (built-in + MCP + dynamic). */
export class ToolRegistry implements vscode.Disposable {
  private tools = new Map<string, Tool>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  register(tool: Tool): vscode.Disposable {
    this.tools.set(tool.definition.name, tool);
    this._onDidChange.fire();
    return new vscode.Disposable(() => {
      this.tools.delete(tool.definition.name);
      this._onDidChange.fire();
    });
  }

  registerAll(tools: Tool[]): vscode.Disposable {
    const ds = tools.map((t) => this.register(t));
    return vscode.Disposable.from(...ds);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(filter?: (t: Tool) => boolean): Tool[] {
    const all = [...this.tools.values()];
    return filter ? all.filter(filter) : all;
  }

  definitions(names?: string[]): ToolDefinition[] {
    const all = names ? names.map((n) => this.tools.get(n)).filter((t): t is Tool => !!t) : [...this.tools.values()];
    return all.map((t) => t.definition);
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `Unknown tool: ${name}. Available: ${[...this.tools.keys()].join(', ')}`, isError: true };
    }
    try {
      return await tool.execute(args, ctx);
    } catch (e) {
      return { content: `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.tools.clear();
  }
}

/** Parse model-supplied JSON args leniently (local models sometimes emit trailing text or single quotes). */
export function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) {
    return {};
  }
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v ? (v as Record<string, unknown>) : {};
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return { _raw: raw };
  }
}
