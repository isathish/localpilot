import * as vscode from 'vscode';
import { Tool, ToolContext, ToolDefinition, ToolResult } from '../types';

/** Central registry of tools available to the agent (built-in + MCP + dynamic). */
export class ToolRegistry implements vscode.Disposable {
  private tools = new Map<string, Tool>();
  /** Tools shadowed by a later registration under the same name; restored when that one is disposed. */
  private shadowed = new Map<string, Tool[]>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  register(tool: Tool): vscode.Disposable {
    const name = tool.definition.name;
    const prev = this.tools.get(name);
    if (prev && prev !== tool) {
      this.shadowed.set(name, [...(this.shadowed.get(name) ?? []), prev]);
    }
    this.tools.set(name, tool);
    this._onDidChange.fire();
    return new vscode.Disposable(() => {
      const stack = this.shadowed.get(name) ?? [];
      if (this.tools.get(name) === tool) {
        const restored = stack.pop();
        if (restored) {
          this.tools.set(name, restored);
        } else {
          this.tools.delete(name);
        }
      } else {
        const i = stack.indexOf(tool);
        if (i >= 0) {
          stack.splice(i, 1);
        }
      }
      if (!stack.length) {
        this.shadowed.delete(name);
      }
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
    this.shadowed.clear();
  }
}

/** Parse model-supplied JSON args leniently (local models sometimes emit trailing text or single quotes). */
export function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) {
    return {};
  }
  try {
    const v: unknown = JSON.parse(raw);
    // A bare JSON string ("src/a.ts") is kept as `_raw`, like unquoted text, for tools that accept a single argument.
    return typeof v === 'string' ? { _raw: v } : typeof v === 'object' && v ? (v as Record<string, unknown>) : {};
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
