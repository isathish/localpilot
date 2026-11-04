import * as vscode from 'vscode';
import { getManagedPolicy } from '../agent/managedPolicy';
import { formatFindings, scanWorkspace } from '../security/scan';
import { Tool } from '../types';

export const securityScanTool: Tool = {
  approvalKind: 'network',
  definition: {
    name: 'security_scan',
    description:
      'Scan the workspace for security problems: vulnerable dependency versions (lockfiles of npm, Yarn, pip/Poetry/Pipenv, Go, Cargo, Bundler checked against the OSV.dev vulnerability database, with the version that fixes each), secrets committed to files (cloud keys, tokens, private keys; values are masked), and risky code (TLS verification off, shell or SQL built from strings, unsafe deserialization, eval). Run it before a release or when asked about security; then fix what it reports — upgrade to the fixed version and run the tests, move secrets to environment variables.',
    parameters: {
      type: 'object',
      properties: {
        kinds: { type: 'array', items: { type: 'string', enum: ['dependencies', 'secrets', 'code', 'all'] }, description: 'Default: all three' },
        path: { type: 'string', description: 'Limit to a workspace-relative folder' },
      },
    },
  },
  async execute(args, ctx) {
    const root = ctx.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return { content: 'No workspace folder open.', isError: true };
    }
    let k: Set<string> | undefined;
    if (Array.isArray(args.kinds) && args.kinds.length) {
      const alias: Record<string, string[]> = { all: ['dependencies', 'secrets', 'code'], dependencies: ['dependencies'], dependency: ['dependencies'], secrets: ['secrets'], secret: ['secrets'], code: ['code'] };
      const bad = args.kinds.map((x) => String(x).trim().toLowerCase()).filter((x) => !alias[x]);
      if (bad.length) {
        return { content: `Unknown kinds: ${bad.join(', ')}. Valid values: "dependencies", "secrets", "code" or "all".`, isError: true };
      }
      k = new Set(args.kinds.flatMap((x) => alias[String(x).trim().toLowerCase()]));
    }
    // Only the dependency check leaves the machine (package names and versions go to OSV.dev).
    const noWeb = !getManagedPolicy().allowWebAccess && (!k || k.has('dependencies'));
    if (noWeb) {
      k = new Set(k ?? ['secrets', 'code']);
      k.delete('dependencies');
    }
    if ((!k || k.has('dependencies')) && !(await ctx.requestApproval('Check dependencies against OSV.dev', 'Package names and versions from the lockfiles are sent to api.osv.dev; no code leaves the machine.', 'network'))) {
      return { content: 'The user declined the online dependency check. Run again with kinds ["secrets", "code"] for the offline checks.', isError: true };
    }
    let r;
    try {
      r = await scanWorkspace(root, { kinds: k ? { dependencies: k.has('dependencies'), secrets: k.has('secrets'), code: k.has('code') } : undefined, path: typeof args.path === 'string' ? args.path : undefined, signal: ctx.signal, progress: (t) => ctx.progress(t) });
    } catch (e) {
      return { content: `Scan failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
    const note = noWeb ? "\n\nDependency check skipped: web access is disabled by your organization's policy." : '';
    return { content: formatFindings(r) + note, data: { findings: r.findings.length } };
  },
};
