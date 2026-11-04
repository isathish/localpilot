import { expandAgentTools, globToRegExp } from './permissions';

/**
 * Tool names from other agents mapped to LocalPilot's: Claude Code (`Read`, `Bash`…) and Cline (`read_files`,
 * `execute_command`…). Used for agent `tools:` lists and for `localpilot.disabledTools`.
 */
const CLAUDE_TOOLS: Record<string, string[]> = {
  Read: ['read_file'],
  Grep: ['grep_search'],
  Glob: ['file_search'],
  Edit: ['edit_file'],
  MultiEdit: ['edit_file'],
  Write: ['write_file'],
  Bash: ['run_command'],
  LS: ['list_dir'],
  WebFetch: ['web_fetch'],
  WebSearch: ['web_search'],
  NotebookRead: ['read_file'],
  Task: ['run_subagent'],
};

const CLINE_TOOLS: Record<string, string[]> = {
  read_files: ['read_file'],
  editor: ['edit_file', 'write_file'],
  run_commands: ['run_command'],
  search_codebase: ['grep_search', 'file_search'],
  execute_command: ['run_command'],
  write_to_file: ['write_file'],
  replace_in_file: ['edit_file'],
  list_files: ['list_dir'],
  search_files: ['grep_search'],
  list_code_definition_names: ['find_symbol'],
  browser_action: ['open_browser'],
  ask_followup_question: ['ask_user'],
};

const bare = (raw: string) => raw.trim().replace(/\(.*\)$/s, '').trim();

/**
 * LocalPilot tool names for a list in any of the supported dialects; our own and unknown names are kept as written,
 * `Bash(git:*)` specifiers are dropped and `mcp__server__tool` becomes `mcp_server_tool`. With `family`, a Claude
 * name also brings the tools its permission rules cover (`Read` → open_file, list_dir, find_symbol…).
 */
export function mapToolNames(list: string[], family = false): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    const name = bare(raw);
    if (!name) {
      continue;
    }
    const direct = CLAUDE_TOOLS[name] ?? CLINE_TOOLS[name];
    direct?.forEach((t) => out.add(t));
    if (CLINE_TOOLS[name] || (direct && !family)) {
      continue;
    }
    const expanded = expandAgentTools([name]);
    // A Claude name that only exists here (NotebookRead) is not kept as an unknown tool.
    expanded.filter((t) => !(direct && t === name)).forEach((t) => out.add(t));
  }
  return [...out];
}

/** Whether `localpilot.disabledTools` switches this tool off: our names, Claude/Cline names, or globs (`mcp_*`, `browser_*`). */
export function toolDisabled(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    const pat = p.trim();
    if (!pat) {
      return false;
    }
    if (/[*?{]/.test(pat)) {
      return globToRegExp(pat).test(name);
    }
    return pat === name || mapToolNames([pat]).includes(name);
  });
}
