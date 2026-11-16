import * as vscode from 'vscode';
import { Tool, ToolContext, ToolDefinition, ToolResult } from '../types';
import { repairJson } from '../agent/healing/jsonRepair';

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
  return parseToolArgs(raw).args;
}

export interface ParsedToolArgs {
  args: Record<string, unknown>;
  /** The arguments were not strict JSON but could be repaired: the repaired JSON text (to store in place of the raw one). */
  repaired?: string;
  /** The arguments look like JSON but could not be parsed or repaired: why. The call must not run. */
  invalid?: string;
}

/**
 * {@link parseArgs} with the verdict: strict JSON, JSON with prose around it, then the deterministic repairs of
 * self-healing (single quotes, trailing commas, unquoted keys, comments…). Text that is not JSON at all is kept as
 * `_raw` for tools that take a single argument; text that looks like JSON but stays broken is `invalid`.
 */
export function parseToolArgs(raw: string): ParsedToolArgs {
  if (!raw || !raw.trim()) {
    return { args: {} };
  }
  let error: string;
  try {
    const v: unknown = JSON.parse(raw);
    // A bare JSON string ("src/a.ts") is kept as `_raw`, like unquoted text, for tools that accept a single argument.
    return { args: typeof v === 'string' ? { _raw: v } : typeof v === 'object' && v && !Array.isArray(v) ? (v as Record<string, unknown>) : {} };
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const v: unknown = JSON.parse(raw.slice(start, end + 1));
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return { args: v as Record<string, unknown>, repaired: JSON.stringify(v) };
      }
    } catch {
      /* repaired below */
    }
  }
  const fixed = repairJson(raw);
  if (fixed.ok && fixed.value && typeof fixed.value === 'object' && !Array.isArray(fixed.value)) {
    return { args: fixed.value as Record<string, unknown>, repaired: JSON.stringify(fixed.value) };
  }
  if (fixed.ok && typeof fixed.value === 'string') {
    return { args: { _raw: fixed.value }, repaired: JSON.stringify(fixed.value) };
  }
  // Plain text (`src/a.ts`) is a single argument, not broken JSON.
  if (!/^\s*[{[]/.test(raw) && !/[{}]/.test(raw)) {
    return { args: { _raw: raw } };
  }
  return { args: {}, invalid: `${error.replace(/\s+/g, ' ').slice(0, 160)}${fixed.truncated ? ' (the JSON is cut off)' : ''}` };
}

/** The tool error for a call whose arguments are not valid JSON: says so plainly, so the model resends the whole call. */
export function invalidArgsMessage(name: string, raw: string, why: string): string {
  const shown = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
  return `The arguments of this ${name} call were not valid JSON (${why}), so nothing was run. Arguments received: ${shown}\nSend the call again with the arguments as one complete JSON object, with double-quoted keys and strings, e.g. {"path": "src/index.ts"}.`;
}
