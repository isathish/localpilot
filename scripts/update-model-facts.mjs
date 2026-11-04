#!/usr/bin/env node
// Regenerates src/providers/modelFacts.json from models.dev: context and output limits, prices per 1M tokens and
// capabilities of the cloud models behind LocalPilot's provider presets. Run by hand and commit the result; the
// extension never fetches this at runtime.
//
//   node scripts/update-model-facts.mjs [path-to-a-saved-api.json]
import { readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const SOURCE = 'https://models.dev/api.json';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'providers', 'modelFacts.json');

/** LocalPilot preset key (src/providers/presets.ts) → models.dev provider id. */
const PROVIDERS = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  openrouter: 'openrouter',
  groq: 'groq',
  deepseek: 'deepseek',
  mistral: 'mistral',
  xai: 'xai',
  together: 'togetherai',
  fireworks: 'fireworks-ai',
  cerebras: 'cerebras',
  moonshot: 'moonshotai',
  dashscope: 'alibaba',
  'ollama-cloud': 'ollama-cloud',
  huggingface: 'huggingface',
  sambanova: 'sambanova',
  minimax: 'minimax',
  zai: 'zai',
  baseten: 'baseten',
  nebius: 'nebius',
  requesty: 'requesty',
  vercel: 'vercel',
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

function facts(m) {
  const out = {
    contextWindow: num(m.limit?.context) || undefined,
    maxOutput: num(m.limit?.output) || undefined,
    input: num(m.cost?.input),
    output: num(m.cost?.output),
    cacheRead: num(m.cost?.cache_read),
    cacheWrite: num(m.cost?.cache_write),
    vision: m.modalities?.input?.includes('image') || undefined,
    reasoning: m.reasoning === true || undefined,
    promptCache: num(m.cost?.cache_read) !== undefined || undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

async function load() {
  const file = process.argv[2];
  if (file) {
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) {
    throw new Error(`${SOURCE}: HTTP ${res.status}`);
  }
  return res.json();
}

const api = await load();
const providers = {};
let count = 0;
for (const [key, source] of Object.entries(PROVIDERS)) {
  const models = api[source]?.models;
  if (!models) {
    console.warn(`models.dev has no provider "${source}" (preset ${key}); skipped`);
    continue;
  }
  const table = {};
  for (const id of Object.keys(models).sort()) {
    const f = facts(models[id]);
    if (Object.keys(f).length) {
      table[id.toLowerCase()] = f;
      count++;
    }
  }
  providers[key] = table;
}

// One model per line keeps the committed diff readable when prices change.
const lines = ['{', `  "source": ${JSON.stringify(SOURCE)},`, `  "updated": ${JSON.stringify(new Date().toISOString().slice(0, 10))},`, '  "providers": {'];
const keys = Object.keys(providers);
keys.forEach((key, i) => {
  const ids = Object.keys(providers[key]);
  lines.push(`    ${JSON.stringify(key)}: {`);
  ids.forEach((id, j) => lines.push(`      ${JSON.stringify(id)}: ${JSON.stringify(providers[key][id])}${j < ids.length - 1 ? ',' : ''}`));
  lines.push(`    }${i < keys.length - 1 ? ',' : ''}`);
});
lines.push('  }', '}', '');
writeFileSync(OUT, lines.join('\n'));
console.log(`Wrote ${count} models from ${keys.length} providers to ${OUT}`);
