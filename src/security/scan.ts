import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { runCmd } from '../tools/git';

/**
 * Security scanning for a workspace, three kinds:
 *  - dependencies: exact versions from lockfiles (npm, Yarn, pip/Poetry/Pipenv, Go, Cargo, Bundler) checked against
 *    OSV.dev, the open vulnerability database (GitHub advisories, PyPA, Go, RustSec…), with the versions that fix each;
 *  - secrets: credentials committed to tracked files (cloud keys, tokens, private keys), found offline and masked;
 *  - code: a short list of high-confidence risky patterns (TLS verification off, shell injection, unsafe loaders).
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export const SEVERITY_ORDER: Severity[] = ['low', 'medium', 'high', 'critical'];

export interface Finding {
  kind: 'dependency' | 'secret' | 'code';
  severity: Severity;
  /** Advisory id (GHSA-…/CVE-…/PYSEC-…) or rule id (`aws-access-key`, `tls-verify-off`). */
  id: string;
  title: string;
  file: string;
  line?: number;
  /** dependency: the package and installed version. */
  package?: { ecosystem: string; name: string; version: string };
  /** dependency: versions that fix it; secret/code: what to do. */
  fix?: string;
  aliases?: string[];
}

export interface Dependency {
  ecosystem: 'npm' | 'PyPI' | 'Go' | 'crates.io' | 'RubyGems';
  name: string;
  version: string;
  file: string;
}

/** PEP 503 normalised PyPI name: `Jupyter_Server` and `jupyter.server` are both `jupyter-server`. */
const pep503 = (n: string) => n.toLowerCase().replace(/[-_.]+/g, '-');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.venv', 'venv', '__pycache__', '.next', 'target', 'coverage', 'vendor', '.vscode-test']);

// ------------------------------------------------------------------ lockfiles (pure)

/** pip requirement files: `*requirements*.txt`, `constraints*.txt`, or any .txt in a `requirements/` folder. */
function isRequirements(file: string): boolean {
  file = file.replace(/\\/g, '/');
  return /^(?:.*requirements.*|constraints.*)\.txt$/.test(path.posix.basename(file)) || /(?:^|\/)requirements\/[^/]+\.txt$/.test(file);
}

/** Exact versions from one lockfile; [] for files it does not understand. */
export function parseLockfile(file: string, text: string): Dependency[] {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const base = path.basename(file);
  const out: Dependency[] = [];
  const add = (ecosystem: Dependency['ecosystem'], name: string, version: string) => {
    if (name && version && /^[\w.+-]+$/.test(version.replace(/^v/, ''))) {
      out.push({ ecosystem, name, version, file });
    }
  };
  try {
    if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') {
      const j = JSON.parse(text) as { packages?: Record<string, { version?: string; name?: string; link?: boolean }>; dependencies?: Record<string, unknown> };
      if (j.packages) {
        for (const [k, v] of Object.entries(j.packages)) {
          const i = k.lastIndexOf('node_modules/');
          // Keys without node_modules/ are the root and workspace packages, not published ones.
          if (i < 0 || v.link || !v.version) {
            continue;
          }
          add('npm', v.name ?? k.slice(i + 'node_modules/'.length), v.version);
        }
      } else {
        const walk = (deps: Record<string, unknown> | undefined) => {
          for (const [name, d] of Object.entries(deps ?? {})) {
            const dep = d as { version?: string; dependencies?: Record<string, unknown> };
            if (dep.version) {
              add('npm', name, dep.version);
            }
            walk(dep.dependencies);
          }
        };
        walk(j.dependencies);
      }
    } else if (base === 'yarn.lock') {
      // Classic: `"name@^1", name@^1.2:\n  version "1.2.3"`; Berry: `"name@npm:^1":\n  version: 1.2.3`.
      for (const m of text.matchAll(/^"?(@?[^@\s"]+)@([^\n]*):\n(?:[ \t]+.*\n)*?[ \t]+version:? "?([^"\s]+)"?/gm)) {
        if (!/@(workspace|link|portal|file|exec):/.test(`@${m[2]}`)) {
          add('npm', m[1], m[3]);
        }
      }
    } else if (isRequirements(file)) {
      for (const m of text.matchAll(/^\s*([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*==\s*([\w.+!-]+)/gm)) {
        add('PyPI', pep503(m[1]), m[2]);
      }
    } else if (base === 'poetry.lock' || base === 'uv.lock' || base === 'Cargo.lock') {
      for (const block of text.split(/^\[\[package\]\]/m).slice(1)) {
        const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
        const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
        // Cargo: workspace crates have no `source`; only published ones can have advisories.
        if (base === 'Cargo.lock' && !/^source\s*=/m.test(block)) {
          continue;
        }
        // uv / Poetry: local, editable and virtual projects are not on PyPI.
        if (base === 'uv.lock' && /^source\s*=\s*\{\s*(editable|virtual|path|directory)\s*=/m.test(block)) {
          continue;
        }
        if (base === 'poetry.lock' && /^\[package\.source\][^[]*^type\s*=\s*"(directory|file)"/m.test(block)) {
          continue;
        }
        if (name && version) {
          add(base === 'Cargo.lock' ? 'crates.io' : 'PyPI', base === 'Cargo.lock' ? name : pep503(name), version);
        }
      }
    } else if (base === 'Pipfile.lock') {
      const j = JSON.parse(text) as Record<string, Record<string, { version?: string }>>;
      for (const sec of ['default', 'develop']) {
        for (const [name, d] of Object.entries(j[sec] ?? {})) {
          if (d.version?.startsWith('==')) {
            add('PyPI', pep503(name), d.version.slice(2));
          }
        }
      }
    } else if (base === 'go.mod') {
      // Directives one per line or in `( … )` blocks; only require counts, rewritten by replace (exclude, retract… ignored).
      const required = new Map<string, string>();
      const replaces: string[] = [];
      let block = '';
      for (const line of text.replace(/\/\/.*$/gm, '').replace(/"/g, '').split('\n').map((l) => l.trim())) {
        let kind = block;
        let rest = line;
        if (block) {
          if (line === ')') {
            block = '';
            continue;
          }
        } else {
          const m = /^(\w+)\s*(\(?)\s*(.*)$/.exec(line);
          if (!m) {
            continue;
          }
          if (m[2]) {
            block = m[3] === ')' ? '' : m[1];
            continue;
          }
          [kind, rest] = [m[1], m[3]];
        }
        if (kind === 'require') {
          const [p, v] = rest.split(/\s+/);
          if (p && v) {
            required.set(p, v);
          }
        } else if (kind === 'replace' && rest.includes('=>')) {
          replaces.push(rest);
        }
      }
      for (const r of replaces) {
        const [[from, fromVer], [to, toVer]] = r.split('=>').map((x) => x.trim().split(/\s+/));
        if (!required.has(from) || (fromVer && required.get(from) !== fromVer)) {
          continue;
        }
        if (toVer) {
          required.delete(from);
          required.set(to, toVer);
        } else if (/^(?:\.{1,2}[\\/]|\/|[A-Za-z]:[\\/])/.test(to ?? '')) {
          // A local directory: not a published module.
          required.delete(from);
        }
      }
      for (const [p, v] of required) {
        add('Go', p, v.replace(/\+incompatible$/, ''));
      }
    } else if (base === 'Gemfile.lock') {
      // Every GEM section (Bundler writes one per gem source); GIT, PATH and PLUGIN SOURCE gems are not on RubyGems.
      for (const sec of text.matchAll(/^GEM\n(?: {2}\S.*\n)*? {2}specs:\n((?: {4}.*(?:\n|$))*)/gm)) {
        for (const m of sec[1].matchAll(/^ {4}([\w.-]+) \(([\w.]+)(?:-[\w-]+)?\)$/gm)) {
          add('RubyGems', m[1], m[2]);
        }
      }
    }
  } catch {
    /* malformed lockfile: nothing from it */
  }
  // One entry per package and version per file (lockfiles repeat nested copies).
  const seen = new Set<string>();
  return out.filter((d) => {
    const k = `${d.ecosystem}|${d.name}|${d.version}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

const LOCKFILES = /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.mod|Cargo\.lock|Gemfile\.lock)$/;
const UNSUPPORTED = /^(pnpm-lock\.yaml|bun\.lockb?|composer\.lock|gradle\.lockfile|pom\.xml|build\.gradle(\.kts)?|packages\.lock\.json|Package\.resolved|pubspec\.lock|mix\.lock)$|\.csproj$/;
const isLockfile = (file: string) => LOCKFILES.test(path.basename(file)) || isRequirements(file);

// ------------------------------------------------------------------ OSV

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string; 'malicious-packages-origins'?: unknown };
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { type?: string; events?: { introduced?: string; fixed?: string }[] }[]; database_specific?: { severity?: string; informational?: string }; ecosystem_specific?: { severity?: string } }[];
}

const CVSS3_WEIGHTS: Record<string, Record<string, number>> = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  C: { H: 0.56, L: 0.22, N: 0 },
  I: { H: 0.56, L: 0.22, N: 0 },
  A: { H: 0.56, L: 0.22, N: 0 },
};

/** Pure: CVSS v3.x base score from a vector (`CVSS:3.1/AV:N/AC:L/…`), undefined when it is not one. */
export function cvss3BaseScore(vector: string): number | undefined {
  if (!/^CVSS:3\.\d\//.test(vector)) {
    return undefined;
  }
  const m = Object.fromEntries(vector.split('/').slice(1).map((p) => p.split(':') as [string, string]));
  const changed = m.S === 'C';
  const pr = ({ N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 } as Record<string, number>)[m.PR];
  const w = (k: string) => CVSS3_WEIGHTS[k][m[k]];
  const [av, ac, ui, c, i, a] = ['AV', 'AC', 'UI', 'C', 'I', 'A'].map(w);
  if ([av, ac, ui, c, i, a, pr].some((x) => x === undefined) || (m.S !== 'U' && !changed)) {
    return undefined;
  }
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) {
    return 0;
  }
  const exploitability = 8.22 * av * ac * pr * ui;
  // CVSS v3.1 Roundup: smallest one-decimal number >= the input, computed in integers to dodge float error.
  const roundup = (x: number) => {
    const n = Math.round(x * 100_000);
    return n % 10_000 === 0 ? n / 100_000 : (Math.floor(n / 10_000) + 1) / 10;
  };
  return roundup(Math.min(changed ? 1.08 * (impact + exploitability) : impact + exploitability, 10));
}

/** Pure: an OSV record's severity on our four-step scale (GitHub's label, else the CVSS base score, else medium). */
export function osvSeverity(v: OsvVuln): Severity {
  // OpenSSF malicious-packages records (MAL-…): the package itself is malware.
  if (v.id.startsWith('MAL-') || v.database_specific?.['malicious-packages-origins']) {
    return 'critical';
  }
  const labelled = v.affected?.find((a) => a.database_specific?.severity || a.ecosystem_specific?.severity);
  const label = (v.database_specific?.severity ?? labelled?.database_specific?.severity ?? labelled?.ecosystem_specific?.severity ?? '').toUpperCase();
  if (label === 'CRITICAL') {
    return 'critical';
  }
  if (label === 'HIGH') {
    return 'high';
  }
  if (label === 'MODERATE' || label === 'MEDIUM') {
    return 'medium';
  }
  if (label === 'LOW') {
    return 'low';
  }
  const raw = v.severity?.find((s) => /CVSS/.test(s.type))?.score ?? '';
  const score = cvss3BaseScore(raw) ?? Number(/(?:^|\/)(\d+(?:\.\d+)?)$/.exec(raw)?.[1]);
  if (Number.isFinite(score) && score > 0) {
    return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
  }
  // RustSec informational advisories (unmaintained, unsound) are not exploitable vulnerabilities.
  if (v.affected?.some((a) => a.database_specific?.informational)) {
    return 'low';
  }
  return 'medium';
}

/** Pure: versions that fix `v` for this package. */
export function osvFixes(v: OsvVuln, dep: Pick<Dependency, 'name' | 'ecosystem'>): string[] {
  const fixes = new Set<string>();
  const norm = (n: string) => (dep.ecosystem === 'PyPI' ? pep503(n) : n.toLowerCase());
  for (const a of v.affected ?? []) {
    if (a.package?.name && norm(a.package.name) !== norm(dep.name)) {
      continue;
    }
    // GIT ranges carry commit hashes, not versions anyone can upgrade to.
    for (const r of (a.ranges ?? []).filter((x) => x.type !== 'GIT')) {
      for (const e of r.events ?? []) {
        if (e.fixed) {
          fixes.add(e.fixed);
        }
      }
    }
  }
  return [...fixes];
}

/** One retry, after a second, when OSV.dev is rate limiting, failing or unreachable. */
async function osvFetch(f: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await f(url, init);
      if (r.ok || attempt || (r.status !== 429 && r.status < 500)) {
        return r;
      }
    } catch (e) {
      if (attempt || init.signal?.aborted) {
        throw e;
      }
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/** `onSkip` hears about the part of the check that could not complete (advisories whose details could not be fetched). */
export async function checkDependencies(deps: Dependency[], opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; progress?: (t: string) => void; onSkip?: (t: string) => void } = {}): Promise<Finding[]> {
  const f = opts.fetchImpl ?? fetch;
  // The same package and version in several lockfiles is queried once and reported against each of them.
  const byKey = new Map<string, Dependency[]>();
  for (const d of deps) {
    const k = `${d.ecosystem}|${d.name}|${d.version}`;
    byKey.set(k, [...(byKey.get(k) ?? []), d]);
  }
  const unique = [...byKey.values()].map((g) => g[0]);
  const hits: { dep: Dependency; ids: string[] }[] = [];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    opts.progress?.(`Checking ${Math.min(i + 500, unique.length)} of ${unique.length} packages against OSV.dev…`);
    const res = await osvFetch(f, 'https://api.osv.dev/v1/querybatch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) }), signal: opts.signal });
    if (!res.ok) {
      throw new Error(`OSV.dev answered ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { results: { vulns?: { id: string }[] }[] };
    body.results.forEach((r, k) => {
      if (r.vulns?.length) {
        hits.push({ dep: chunk[k], ids: r.vulns.map((v) => v.id) });
      }
    });
  }
  const ids = [...new Set(hits.flatMap((h) => h.ids))];
  const details = new Map<string, OsvVuln>();
  const unresolved = new Set<string>();
  for (let i = 0; i < ids.length; i += 8) {
    const batch = ids.slice(i, i + 8);
    const settled = await Promise.allSettled(
      batch.map(async (id) => {
        const r = await osvFetch(f, `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { signal: opts.signal });
        if (!r.ok) {
          throw new Error(`OSV.dev answered ${r.status}`);
        }
        details.set(id, (await r.json()) as OsvVuln);
      })
    );
    opts.signal?.throwIfAborted();
    settled.forEach((s, k) => s.status === 'rejected' && unresolved.add(batch[k]));
  }
  if (unresolved.size) {
    opts.onSkip?.(`dependencies: details for ${unresolved.size} advisor${unresolved.size === 1 ? 'y' : 'ies'} could not be fetched`);
  }
  const out: Finding[] = [];
  for (const { dep, ids: vids } of hits) {
    // The same advisory under several ids (GHSA and PYSEC for one issue) is reported once, under the GHSA id.
    const seen = new Set<string>();
    for (const id of vids.sort((a, b) => Number(b.startsWith('GHSA')) - Number(a.startsWith('GHSA')))) {
      const v = details.get(id) ?? { id };
      const keys = [v.id, ...(v.aliases ?? [])];
      if (keys.some((k) => seen.has(k))) {
        continue;
      }
      keys.forEach((k) => seen.add(k));
      const fixes = osvFixes(v, dep);
      const title = unresolved.has(id) ? `${id} (details unavailable)` : v.summary ?? v.details?.split('\n')[0]?.slice(0, 120) ?? v.id;
      for (const d of byKey.get(`${dep.ecosystem}|${dep.name}|${dep.version}`) ?? [dep]) {
        out.push({ kind: 'dependency', severity: osvSeverity(v), id: v.id, title, file: d.file, package: { ecosystem: d.ecosystem, name: d.name, version: d.version }, fix: v.id.startsWith('MAL-') ? 'remove this package or pin a version not listed as malicious' : unresolved.has(id) ? `see https://osv.dev/vulnerability/${id}` : fixes.length ? `upgrade ${d.name} to ${fixes.join(' or ')}` : 'no fixed version published yet', aliases: v.aliases?.filter((a) => a.startsWith('CVE-')) });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ secrets and code (pure)

interface Rule {
  id: string;
  title: string;
  severity: Severity;
  re: RegExp;
  files?: RegExp;
  fix: string;
  /** For secrets: the capture group holding the value, checked for placeholders and entropy. */
  value?: number;
}

const SECRET_RULES: Rule[] = [
  { id: 'private-key', title: 'Private key', severity: 'critical', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/, fix: 'remove it from the repository, rotate the key, load it from a file outside the repo or a secret store' },
  { id: 'aws-access-key', title: 'AWS access key id', severity: 'critical', re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/, value: 1, fix: 'deactivate the key in IAM and read credentials from the environment or a profile' },
  { id: 'github-token', title: 'GitHub token', severity: 'critical', re: /\b((?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}))\b/, value: 1, fix: 'revoke it on GitHub and read it from an environment variable' },
  { id: 'anthropic-key', title: 'Anthropic API key', severity: 'critical', re: /\b(sk-ant-[A-Za-z0-9_-]{30,})/, value: 1, fix: 'rotate it in the Anthropic console and read it from the environment' },
  { id: 'openai-key', title: 'OpenAI API key', severity: 'critical', re: /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,})\b/, value: 1, fix: 'rotate it in the OpenAI dashboard and read it from the environment' },
  { id: 'slack-token', title: 'Slack token', severity: 'high', re: /\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/, value: 1, fix: 'revoke it in Slack and read it from the environment' },
  { id: 'google-api-key', title: 'Google API key', severity: 'high', re: /\b(AIza[0-9A-Za-z_-]{35})\b/, value: 1, fix: 'restrict or rotate it in Google Cloud and read it from the environment' },
  { id: 'stripe-key', title: 'Stripe live key', severity: 'critical', re: /\b((?:sk|rk)_live_[0-9A-Za-z]{24,})\b/, value: 1, fix: 'roll it in the Stripe dashboard and read it from the environment' },
  { id: 'hardcoded-credential', title: 'Hard-coded password or token', severity: 'high', re: /(?<![A-Za-z0-9])[\w.-]*?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)[\w.-]*["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i, value: 1, fix: 'read it from an environment variable or a secret store' },
  // Config and .env files: unquoted values.
  { id: 'hardcoded-credential', title: 'Hard-coded password or token', severity: 'high', re: /(?<![A-Za-z0-9])[\w.-]*?(?:password|passwd|secret|token|api[_-]?key)[\w.-]*\s*[:=]\s*([^\s"'#]{12,})/i, files: /(^|\/)\.env[^/]*$|\.(ya?ml|properties|ini|toml|cfg)$/, value: 1, fix: 'read it from an environment variable or a secret store' },
];

const CODE_RULES: Rule[] = [
  { id: 'tls-verify-off', title: 'TLS certificate verification disabled', severity: 'high', re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|InsecureSkipVerify\s*:\s*true|\bverify\s*=\s*False\b|ssl\._create_unverified_context|CURLOPT_SSL_VERIFYPEER,\s*(?:0|false)/, fix: 'keep verification on; trust a custom CA instead of turning checks off' },
  { id: 'shell-injection', title: 'Shell command built from variables', severity: 'high', re: /(?:\bexecSync|\bexec)\s*\(\s*`[^`]*\$\{|subprocess\.\w+\([^)]*shell\s*=\s*True|os\.system\s*\(\s*(?:f["']|[^)]*(?:%|\.format\(|\+))/, fix: 'pass the program and its arguments as a list (spawn/execFile, subprocess.run([...])) instead of a shell string' },
  { id: 'sql-concat', title: 'SQL built by string concatenation', severity: 'high', re: /\.(?:execute|query|raw)\s*\(\s*(?:f["'][^"']*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"']*\{|`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{|["'][^"']*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"']*["']\s*(?:\+|%))/i, fix: 'use query parameters (placeholders) instead of building the SQL string' },
  { id: 'unsafe-deserialization', title: 'Unsafe deserialization', severity: 'medium', re: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*Loader\s*=\s*yaml\.(?:Safe|CSafe)Loader)|\bmarshal\.loads\s*\(/, files: /\.py$/, fix: 'use a safe loader (yaml.safe_load, json) for data that is not fully trusted' },
  { id: 'eval', title: 'eval / dynamic code', severity: 'medium', re: /(?<![\w.])eval\s*\(\s*(?!["'`])|new Function\s*\(/, files: /\.(?:[cm]?[jt]sx?|py)$/, fix: 'parse the input instead of evaluating it (JSON.parse, ast.literal_eval)' },
];

// Whole-value fillers (xxxx, ****, <token>, ${VAR}), values that start like an example, or the key's own name.
const PLACEHOLDER = /^(?:x+|\*+|\.+|<[^>]*>|\$\{.*\}|\{\{.*\}\})$|^(?:your|example|changeme|change_me|placeholder|dummy|test|sample|redacted)|^(?:password|secret|token|api[_-]?key)\d*$/i;

/** Shannon entropy in bits per character: real secrets are random, placeholders and words are not. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.values()].reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
}

export const mask = (s: string) => (s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`);

/** Pure: secret and risky-code findings in one file. */
export function scanText(file: string, text: string, kinds: { secrets: boolean; code: boolean }): Finding[] {
  const out: Finding[] = [];
  const lines = text.split('\n');
  const isTest = /(^|\/)(tests?|__tests__|spec|fixtures?|examples?)\/|\.(test|spec)\.|_test\.(go|py)$/.test(file);
  lines.forEach((line, i) => {
    if (line.length > 2000 || /localpilot-scan:\s*ignore|nosec|gitleaks:allow/.test(line)) {
      return;
    }
    if (kinds.secrets) {
      for (const r of SECRET_RULES) {
        const m = (!r.files || r.files.test(file)) && r.re.exec(line);
        if (!m) {
          continue;
        }
        const value = r.value ? m[r.value] : m[0];
        if (r.id === 'hardcoded-credential' && (PLACEHOLDER.test(value) || entropy(value) < 3.3 || /\$\{|%\(|\{\{/.test(value) || /process\.env|os\.environ|getenv|\$\{/.test(line))) {
          continue;
        }
        out.push({ kind: 'secret', severity: isTest && r.severity === 'critical' ? 'high' : r.severity, id: r.id, title: `${r.title}${r.id === 'private-key' ? '' : `: ${mask(value)}`}`, file, line: i + 1, fix: r.fix });
        break;
      }
    }
    if (kinds.code && !/^\s*(\/\/|#|\*|--)/.test(line)) {
      for (const r of CODE_RULES) {
        if ((!r.files || r.files.test(file)) && r.re.test(line)) {
          out.push({ kind: 'code', severity: isTest ? 'low' : r.severity, id: r.id, title: r.title, file, line: i + 1, fix: r.fix });
        }
      }
    }
  });
  return out;
}

// ------------------------------------------------------------------ workspace

const WALK_SKIP_DOT = new Set(['.git', '.cache', '.yarn', '.pnpm-store', '.gradle', '.terraform', '.tox', '.mypy_cache', '.pytest_cache', '.nuxt', '.svelte-kit', '.turbo', '.angular', '.idea', '.venv']);

async function trackedFiles(root: string, prefix: string): Promise<{ files: string[]; note?: string }> {
  const g = await runCmd('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root, undefined, 60_000);
  if (g.code === 0) {
    return { files: g.out.split('\0').filter(Boolean) };
  }
  let note = `git ls-files failed (${(g.err || '').trim().split('\n')[0] || 'not a git repository'}); walked the folder instead, .gitignore not applied`;
  const out: string[] = [];
  const walk = async (rel: string) => {
    for (const e of await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
      if (out.length >= 20_000) {
        return;
      }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !WALK_SKIP_DOT.has(e.name)) {
        await walk(r);
      } else if (e.isFile()) {
        out.push(r);
      }
    }
  };
  if (prefix && (await fs.promises.stat(path.join(root, prefix)).catch(() => undefined))?.isFile()) {
    out.push(prefix);
  } else {
    await walk(prefix);
  }
  if (out.length >= 20_000) {
    note += '; stopped after 20,000 files';
  }
  return { files: out, note };
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|woff2?|ttf|eot|mp[34]|mov|wasm|so|dylib|dll|exe|bin|vsix|lock)$/i;

export interface ScanOptions {
  kinds?: { dependencies?: boolean; secrets?: boolean; code?: boolean };
  /** Limit to a sub-folder (workspace-relative). */
  path?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  progress?: (t: string) => void;
}

export interface ScanResult {
  root: string;
  findings: Finding[];
  dependencies: number;
  files: number;
  /** A part that could not run (e.g. OSV.dev unreachable), with the reason. */
  skipped: string[];
  /** The kinds that ran. */
  kinds?: { dependencies: boolean; secrets: boolean; code: boolean };
  /** Where `root` sits in its git repository (`sub/dir`), so SARIF paths are repository-relative. */
  prefix?: string;
}

export async function scanWorkspace(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const kinds = { dependencies: opts.kinds?.dependencies ?? true, secrets: opts.kinds?.secrets ?? true, code: opts.kinds?.code ?? true };
  let rel = (opts.path ?? '').trim();
  if (path.isAbsolute(rel)) {
    rel = path.relative(root, rel);
  }
  rel = rel.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (rel === '.') {
    rel = '';
  }
  if (rel === '..' || rel.startsWith('../')) {
    throw new Error('path is outside the workspace');
  }
  if (rel && !fs.existsSync(path.join(root, rel))) {
    throw new Error(`No such file or folder: ${rel}`);
  }
  const tracked = await trackedFiles(root, rel);
  const files = tracked.files.filter((f) => (!rel || f === rel || f.startsWith(`${rel}/`)) && !f.split('/').some((s) => SKIP_DIRS.has(s)));
  if (rel && !files.length) {
    throw new Error(`No files under "${rel}"`);
  }
  const findings: Finding[] = [];
  const skipped: string[] = tracked.note ? [tracked.note] : [];
  let deps: Dependency[] = [];
  if (kinds.dependencies) {
    for (const f of files.filter(isLockfile)) {
      deps.push(...parseLockfile(f, await fs.promises.readFile(path.join(root, f), 'utf8').catch(() => '')));
    }
    deps = deps.filter((d, i) => deps.findIndex((e) => e.ecosystem === d.ecosystem && e.name === d.name && e.version === d.version && e.file === d.file) === i);
    const unsupported = files.filter((x) => UNSUPPORTED.test(path.basename(x)));
    skipped.push(...unsupported.slice(0, 5).map((f) => `dependencies: ${f} is not supported, not checked`));
    if (unsupported.length > 5) {
      skipped.push(`dependencies: … and ${unsupported.length - 5} more unsupported files, not checked`);
    }
    if (deps.length) {
      try {
        findings.push(...(await checkDependencies(deps, { ...opts, onSkip: (t) => skipped.push(t) })));
      } catch (e) {
        skipped.push(`dependencies: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      skipped.push('dependencies: no supported lockfile found');
    }
  }
  let read = 0;
  if (kinds.secrets || kinds.code) {
    opts.progress?.(`Reading ${files.length} files…`);
    for (const f of files) {
      if (BINARY.test(f) || /\.min\.(js|css)$/.test(f) || isLockfile(f)) {
        continue;
      }
      let text: string;
      try {
        const st = await fs.promises.stat(path.join(root, f));
        if (st.size > 1_000_000) {
          continue;
        }
        text = await fs.promises.readFile(path.join(root, f), 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) {
        continue;
      }
      read++;
      findings.push(...scanText(f, text, { secrets: kinds.secrets, code: kinds.code }));
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  const git = await runCmd('git', ['rev-parse', '--show-prefix'], root, undefined, 10_000).catch(() => undefined);
  const prefix = git?.code === 0 ? git.out.trim().replace(/\/+$/, '') : '';
  return { root, findings, dependencies: deps.length, files: read, skipped, kinds, prefix };
}

// ------------------------------------------------------------------ reports (pure)

export function formatFindings(r: ScanResult, max = 60): string {
  const by = (s: Severity) => r.findings.filter((f) => f.severity === s).length;
  const notRun = r.kinds ? (['dependencies', 'secrets', 'code'] as const).filter((k) => !r.kinds![k]) : [];
  const head = `${r.findings.length ? `${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}` : 'No findings'} (${SEVERITY_ORDER.slice().reverse().map((s) => `${by(s)} ${s}`).join(', ')}) — ${r.dependencies} dependencies checked against OSV.dev, ${r.files} files scanned.${notRun.length ? ` ${notRun.join(' and ')} not checked.` : ''}${r.skipped.length ? `\nSkipped: ${r.skipped.join('; ')}` : ''}`;
  const rows = r.findings.slice(0, max).map((f) => {
    const where = `${f.file}${f.line ? `:${f.line}` : ''}`;
    return f.kind === 'dependency'
      ? `[${f.severity}] ${f.package!.name} ${f.package!.version} (${f.package!.ecosystem}) — ${f.title} (${[f.id, ...(f.aliases ?? [])].join(', ')}) in ${where}. Fix: ${f.fix}`
      : `[${f.severity}] ${f.title} — ${where} (${f.id}). Fix: ${f.fix}`;
  });
  return `${head}${rows.length ? `\n\n${rows.join('\n')}` : ''}${r.findings.length > max ? `\n… and ${r.findings.length - max} more` : ''}`;
}

/** SARIF 2.1.0, the format GitHub code scanning (and most CI dashboards) read. */
export function toSarif(r: ScanResult, version: string): object {
  const level = (s: Severity) => (s === 'critical' || s === 'high' ? 'error' : s === 'medium' ? 'warning' : 'note');
  // One rule per id, rated by its most severe finding.
  const top = new Map<string, Finding>();
  for (const f of r.findings) {
    const had = top.get(f.id);
    if (!had || SEVERITY_ORDER.indexOf(f.severity) > SEVERITY_ORDER.indexOf(had.severity)) {
      top.set(f.id, f);
    }
  }
  const rules = [...top.values()].map((f) => ({ id: f.id, name: f.id, shortDescription: { text: f.kind === 'dependency' ? `${f.package!.name}: ${f.title}` : f.title.replace(/:.*$/, '') }, help: { text: f.fix ?? '' }, properties: { 'security-severity': ({ low: '3.0', medium: '5.5', high: '8.0', critical: '9.5' } as const)[f.severity], tags: ['security', f.kind] } }));
  const uri = (file: string) => (r.prefix ? path.posix.join(r.prefix, file) : file);
  const fingerprint = (f: Finding) => crypto.createHash('sha256').update([f.id, f.package!.ecosystem, f.package!.name, f.package!.version, f.file].join('|')).digest('hex');
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'LocalPilot security scan', version, informationUri: 'https://isathish.github.io/localpilot/', rules } },
      ...(r.skipped.length ? { invocations: [{ executionSuccessful: false, toolExecutionNotifications: r.skipped.map((t) => ({ message: { text: t } })) }] } : {}),
      results: r.findings.map((f) => ({ ruleId: f.id, level: level(f.severity), message: { text: f.kind === 'dependency' ? `${f.package!.name} ${f.package!.version}: ${f.title}. ${f.fix}` : `${f.title}. ${f.fix}` }, locations: [{ physicalLocation: { artifactLocation: { uri: uri(f.file) }, ...(f.line ? { region: { startLine: f.line } } : {}) } }], ...(f.kind === 'dependency' ? { partialFingerprints: { primaryLocationLineHash: fingerprint(f) } } : {}) })),
    }],
  };
}
