import * as os from 'os';
import * as path from 'path';
import { PermissionSettings } from './settings';

/**
 * Claude Code permission rules: `Tool` or `Tool(specifier)` strings in the `allow` / `deny` / `ask` lists.
 *
 *   Bash(npm run build)        exact command          Bash(npm run test:*)   command prefix
 *   Edit(src/**)               path glob (also Write) Read(~/.zshrc)         ~ = home, // = absolute, / = project root
 *   WebFetch(domain:foo.com)   host (+ subdomains)    mcp__server__tool      MCP tool, mcp__server = every tool of it
 *   Task(agent-name)           subagent               Skill(name)            skill
 *
 * Rules name Claude Code's tools; LocalPilot's tools are matched through the alias table below, and a rule may also
 * use a LocalPilot tool name directly (`run_command(git *)`). `deny` wins over `ask`, which wins over `allow`.
 */

export type Decision = 'allow' | 'deny' | 'ask';

export interface PermissionResult {
  decision: Decision | 'none';
  /** The rule that decided. */
  rule?: string;
}

export interface PermissionRule {
  raw: string;
  tool: string;
  specifier?: string;
}

/** Claude Code tool name(s) each LocalPilot tool answers to. The first is the canonical one shown to hooks. */
export const TOOL_ALIASES: Record<string, string[]> = {
  run_command: ['Bash'],
  edit_file: ['Edit', 'MultiEdit'],
  write_file: ['Write', 'Edit'],
  create_directory: ['Write', 'Edit'],
  delete_path: ['Delete', 'Edit'],
  read_file: ['Read'],
  open_file: ['Read'],
  list_dir: ['LS', 'Read'],
  file_search: ['Glob', 'Read'],
  grep_search: ['Grep', 'Read'],
  find_symbol: ['Grep', 'Read'],
  find_references: ['Grep', 'Read'],
  get_diagnostics: ['Read'],
  web_fetch: ['WebFetch'],
  web_search: ['WebSearch'],
  run_subagent: ['Task'],
  run_parallel_subagents: ['Task'],
  run_todos_parallel: ['Task'],
  load_skill: ['Skill'],
  ask_user: ['AskUserQuestion'],
  manage_todos: ['TodoWrite'],
  show_markdown: ['Read'],
  open_browser: ['WebFetch'],
  browser_inspect: ['WebFetch'],
  browser_screenshot: ['WebFetch'],
};

/** Tools whose specifier is a file path pattern. */
const PATH_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'Delete', 'Read', 'LS', 'Glob', 'Grep', 'NotebookEdit', 'NotebookRead']);
/** Tools that change files: `acceptEdits` mode auto-approves these. */
export const EDIT_FAMILY = new Set(['Edit', 'MultiEdit', 'Write', 'Delete', 'NotebookEdit']);

/** Claude Code's canonical name for one of our tools (`run_command` → `Bash`); MCP tools map to `mcp__server__tool`. */
export function canonicalToolName(name: string): string {
  const alias = TOOL_ALIASES[name]?.[0];
  if (alias) {
    return alias;
  }
  const mcp = /^mcp_(.+)$/.exec(name);
  if (mcp) {
    return `mcp__${mcp[1].replace(/_/, '__')}`;
  }
  return name;
}

/** Every name a rule may use for this tool: our own, the Claude aliases, and `mcp__server` / `mcp__server__tool`. */
export function toolNames(name: string): string[] {
  const names = [name, ...(TOOL_ALIASES[name] ?? [])];
  const mcp = /^mcp_([^_]+)_(.+)$/.exec(name);
  if (mcp) {
    names.push(`mcp__${mcp[1]}__${mcp[2]}`, `mcp__${mcp[1]}`);
  } else if (name.startsWith('mcp_')) {
    names.push(`mcp__${name.slice(4).replace(/_/, '__')}`);
  }
  return names;
}

export function parseRule(raw: string): PermissionRule | undefined {
  const s = raw.trim();
  if (!s) {
    return undefined;
  }
  const m = /^([A-Za-z0-9_:-]+)(?:\((.*)\))?$/s.exec(s);
  if (!m) {
    return undefined;
  }
  const spec = m[2]?.trim();
  return { raw: s, tool: m[1], specifier: spec === undefined || spec === '' || spec === '*' ? undefined : spec };
}

/** gitignore / minimatch-style glob → RegExp (`**`, `*`, `?`, `{a,b}`); `*` does not cross `/`. */
export function globToRegExp(glob: string, opts: { prefix?: boolean } = {}): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map((p) => globToRegExp(p).source.replace(/^\^|\$$/g, ''))
          .join('|')})`;
        i = end;
      } else {
        re += '\\{';
      }
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}${opts.prefix ? '(?:/.*)?' : ''}$`);
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** Does a path rule match this file? `//` absolute, `~/` home, `/x` and `x` relative to the project root. */
export function matchPathRule(spec: string, target: string, root: string | undefined, home = os.homedir()): boolean {
  let pattern = spec.trim().replace(/\\/g, '/');
  let candidates: string[];
  const abs = norm(path.isAbsolute(target) ? target : path.resolve(root ?? process.cwd(), target));
  if (pattern.startsWith('//')) {
    // `//etc/**` is absolute; on Windows `//C:/...` names a drive and must not keep a leading slash.
    pattern = pattern.slice(2);
    pattern = /^[a-zA-Z]:/.test(pattern) ? pattern : `/${pattern}`;
    candidates = [abs];
  } else if (pattern.startsWith('~/')) {
    pattern = norm(home) + pattern.slice(1);
    candidates = [abs];
  } else {
    pattern = pattern.replace(/^\.?\//, '');
    const rel = root ? norm(path.relative(root, abs)) : norm(target);
    candidates = rel.startsWith('..') ? [abs] : [rel, abs];
  }
  const hasMagic = /[*?{]/.test(pattern);
  // gitignore semantics: a plain directory name covers everything underneath it, and a pattern without `/`
  // (`*.env`, `secrets.json`) matches at any depth.
  const res = [globToRegExp(pattern, { prefix: !hasMagic })];
  if (!pattern.includes('/')) {
    res.push(globToRegExp(`**/${pattern}`, { prefix: !hasMagic }));
  }
  return candidates.some((c) => res.some((re) => re.test(c)));
}

/** Split a shell line into the simple commands it chains (`a && b | c`), outside quotes. */
export function splitCommandChain(command: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === quote && command[i - 1] !== '\\') {
        quote = undefined;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if ((c === '&' && command[i + 1] === '&') || (c === '|' && command[i + 1] === '|')) {
      parts.push(cur);
      cur = '';
      i++;
    } else if (c === ';' || c === '|' || c === '\n') {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** `Bash(npm run test:*)` is a prefix; `Bash(git status)` exact; `*` wildcards anywhere. */
export function matchCommandRule(spec: string, command: string): boolean {
  const cmd = command.trim().replace(/\s+/g, ' ');
  const s = spec.trim().replace(/\s+/g, ' ');
  if (s.endsWith(':*')) {
    const prefix = s.slice(0, -2);
    return cmd === prefix || cmd.startsWith(prefix + ' ') || cmd.startsWith(prefix);
  }
  if (s.includes('*')) {
    const re = new RegExp(`^${s.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(cmd);
  }
  return cmd === s;
}

export function matchDomainRule(spec: string, url: string): boolean {
  const m = /^domain:(.+)$/i.exec(spec.trim());
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = url.toLowerCase();
  }
  if (m) {
    const d = m[1].trim().toLowerCase().replace(/^\*\./, '');
    return host === d || host.endsWith(`.${d}`);
  }
  return matchCommandRule(spec, url);
}

/** The argument a tool's specifier is compared against. */
export function specifierTarget(toolName: string, args: Record<string, unknown>): { kind: 'command' | 'path' | 'url' | 'text'; value: string } | undefined {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
  switch (toolName) {
    case 'run_command':
      return str('command') ? { kind: 'command', value: str('command')! } : undefined;
    case 'web_fetch':
    case 'open_browser':
    case 'browser_inspect':
    case 'browser_screenshot':
      return str('url') ? { kind: 'url', value: str('url')! } : undefined;
    case 'web_search':
      return str('query') ? { kind: 'text', value: str('query')! } : undefined;
    case 'file_search':
      return str('pattern') ? { kind: 'path', value: str('pattern')! } : undefined;
    case 'grep_search':
      return { kind: 'path', value: str('include_pattern') ?? str('path') ?? '.' };
    case 'run_subagent':
      return str('agent') ? { kind: 'text', value: str('agent')! } : undefined;
    case 'load_skill':
      return str('name') ? { kind: 'text', value: str('name')! } : undefined;
    default: {
      const p = str('path') ?? str('file_path') ?? str('file');
      if (p !== undefined) {
        return { kind: 'path', value: p };
      }
      const first = Object.values(args).find((v): v is string => typeof v === 'string');
      return first !== undefined ? { kind: 'text', value: first } : undefined;
    }
  }
}

export interface MatchContext {
  root?: string;
  home?: string;
}

/** Does one rule apply to this call? `mode` decides how a chained command is judged (every part for allow, any for deny/ask). */
export function ruleMatches(rule: PermissionRule, toolName: string, args: Record<string, unknown>, ctx: MatchContext, mode: Decision): boolean {
  const names = toolNames(toolName);
  const ruleTool = rule.tool;
  const nameMatches = names.includes(ruleTool) || (ruleTool.startsWith('mcp__') && names.some((n) => n === ruleTool || n.startsWith(`${ruleTool}__`)));
  if (!nameMatches) {
    return false;
  }
  if (!rule.specifier) {
    return true;
  }
  const target = specifierTarget(toolName, args);
  if (!target) {
    return false;
  }
  if (target.kind === 'command') {
    const parts = splitCommandChain(target.value);
    const one = (c: string) => matchCommandRule(rule.specifier!, c);
    return mode === 'allow' ? parts.length > 0 && parts.every(one) : parts.some(one);
  }
  if (target.kind === 'url') {
    return matchDomainRule(rule.specifier, target.value);
  }
  if (target.kind === 'path' || PATH_TOOLS.has(ruleTool)) {
    return matchPathRule(rule.specifier, target.value, ctx.root, ctx.home);
  }
  return matchCommandRule(rule.specifier, target.value);
}

/** Evaluate the rule lists for a tool call. `extraAllow` are per-run rules (a slash command's `allowed-tools`). */
export function evaluatePermission(perm: PermissionSettings, toolName: string, args: Record<string, unknown>, ctx: MatchContext = {}, extraAllow: string[] = []): PermissionResult {
  const lists: [Decision, string[]][] = [
    ['deny', perm.deny],
    ['ask', perm.ask],
    ['allow', [...perm.allow, ...extraAllow]],
  ];
  for (const [decision, rules] of lists) {
    for (const raw of rules) {
      const rule = parseRule(raw);
      if (rule && ruleMatches(rule, toolName, args, ctx, decision)) {
        return { decision, rule: rule.raw };
      }
    }
  }
  return { decision: 'none' };
}

/** What `permissions.defaultMode` says when no rule matched. */
export function defaultModeDecision(mode: PermissionSettings['defaultMode'], toolName: string): Decision | 'none' {
  if (mode === 'bypassPermissions') {
    return 'allow';
  }
  if (mode === 'acceptEdits' && (TOOL_ALIASES[toolName] ?? []).some((a) => EDIT_FAMILY.has(a))) {
    return 'allow';
  }
  if (mode === 'dontAsk') {
    return 'deny';
  }
  return 'none';
}

/** Maps a hook's `updatedInput` (Claude field names) back onto our tool's arguments. */
export function fromClaudeToolInput(toolName: string, updated: Record<string, unknown>, original: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...original };
  const aliases: Record<string, string> = { file_path: 'path', old_string: 'old_text', new_string: 'new_text', subagent_type: 'agent' };
  if (toolName === 'grep_search') {
    aliases.pattern = 'query';
    aliases.glob = 'include_pattern';
  }
  for (const [k, v] of Object.entries(updated)) {
    out[aliases[k] ?? k] = v;
  }
  return out;
}

/** Shapes our tool arguments the way Claude Code hooks expect (`tool_input.file_path`, `tool_input.command`, …). */
export function claudeToolInput(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  const p = args.path;
  if (typeof p === 'string' && out.file_path === undefined) {
    out.file_path = p;
  }
  if (toolName === 'edit_file') {
    out.old_string ??= args.old_text;
    out.new_string ??= args.new_text;
  }
  if (toolName === 'file_search' && typeof args.pattern === 'string') {
    out.pattern = args.pattern;
  }
  if (toolName === 'grep_search') {
    out.pattern ??= args.query;
    out.glob ??= args.include_pattern;
  }
  if (toolName === 'run_subagent') {
    out.subagent_type ??= args.agent;
  }
  return out;
}
