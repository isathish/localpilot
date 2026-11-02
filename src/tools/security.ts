import * as vscode from 'vscode';
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
        kinds: { type: 'array', items: { type: 'string', enum: ['dependencies', 'secrets', 'code'] }, description: 'Default: all three' },
        path: { type: 'string', description: 'Limit to a workspace-relative folder' },
      },
    },
  },
  async execute(args, ctx) {
    const root = ctx.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return { content: 'No workspace folder open.', isError: true };
    }
    const k = Array.isArray(args.kinds) && args.kinds.length ? new Set(args.kinds.map(String)) : undefined;
    // Only the dependency check leaves the machine (package names and versions go to OSV.dev).
    if ((!k || k.has('dependencies')) && !(await ctx.requestApproval('Check dependencies against OSV.dev', 'Package names and versions from the lockfiles are sent to api.osv.dev; no code leaves the machine.', 'network'))) {
      return { content: 'The user declined the online dependency check. Run again with kinds ["secrets", "code"] for the offline checks.', isError: true };
    }
    const r = await scanWorkspace(root, { kinds: k ? { dependencies: k.has('dependencies'), secrets: k.has('secrets'), code: k.has('code') } : undefined, path: typeof args.path === 'string' ? args.path : undefined, signal: ctx.signal, progress: (t) => ctx.progress(t) });
    return { content: formatFindings(r), data: { findings: r.findings.length } };
  },
};
