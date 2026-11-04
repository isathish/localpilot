/** Pure helpers behind the REPL's `/settings` (no `vscode` import, so the smoke test runs them offline). */

const SECRET_KEY = /(api[-_]?key|token|secret|password|passwd|authorization|cookie|credential)/i;

/** Copies `value` with secret-looking strings masked; `${env:…}` / `${secret:…}` references are kept (they hold no key). */
export function redactSecrets(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    return SECRET_KEY.test(key) && value && !/^\$\{(env|secret):[^}]+\}$/.test(value.trim()) ? '••••' : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, key));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactSecrets(v, k)]));
  }
  return value;
}

/** `key = value` rows for the effective settings, sorted, secrets masked; `filter` keeps keys containing it. */
export function settingsRows(settings: Record<string, unknown>, filter = ''): string[] {
  const f = filter.trim().toLowerCase().replace(/^localpilot\./, '');
  return Object.keys(settings)
    .filter((k) => !f || k.toLowerCase().includes(f))
    .sort()
    .map((k) => {
      const v = JSON.stringify(redactSecrets(settings[k], k));
      return `${k} = ${v && v.length > 160 ? `${v.slice(0, 159)}…` : v}`;
    });
}

/** `/settings set <key> <value>`: JSON when it parses (`true`, `3`, `["a"]`), otherwise the text as typed. */
export function parseSettingValue(raw: string): unknown {
  const t = raw.trim();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** A setting key as written in config.json: without the `localpilot.` prefix; undefined when it is not a key. */
export function settingKey(raw: string): string | undefined {
  const k = raw.trim().replace(/^localpilot\./, '');
  return /^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)*$/.test(k) ? k : undefined;
}
