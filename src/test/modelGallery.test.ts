import * as assert from 'assert';
import { DockerHubRegistry, firstParagraph, galleryInstallRef, groupQuants, HuggingFaceRegistry, isValidInstallRef, relativeTime, sizesFromName } from '../providers/modelGallery';

const HUB_LIST = {
  count: 3,
  next: null,
  results: [
    { name: 'qwen3', description: '', pull_count: 888390, star_count: 219, last_updated: '2026-08-17T14:03:18Z' },
    { name: 'smollm2', description: 'Compact instruction model', pull_count: 868841, star_count: 40, last_updated: '2026-09-01T00:00:00Z' },
    { name: 'mxbai-embed-large', description: '', pull_count: 48979, star_count: 3, last_updated: '2026-07-01T00:00:00Z' },
  ],
};
const HUB_SEARCH = { count: 2, results: [{ repo_name: 'ai/qwen3-coder', short_description: 'Agentic coder', pull_count: 361124 }, { repo_name: 'someone/qwen3', pull_count: 5 }] };
const HUB_TAGS = {
  count: 5,
  next: null,
  results: [
    { name: 'latest', full_size: 5261334528, digest: 'sha256:aaaaaaaaaaaa1111', last_updated: '2026-08-15T00:00:00Z' },
    { name: '8b', full_size: 5261334528, digest: 'sha256:aaaaaaaaaaaa1111', last_updated: '2026-08-15T00:00:00Z' },
    { name: '0.6b', full_size: 396705472, digest: 'sha256:bbbbbbbbbbbb2222', last_updated: '2026-08-15T00:00:00Z' },
    { name: '8b-safetensors', full_size: 16400000000, digest: 'sha256:cccccccccccc3333', last_updated: '2026-08-15T00:00:00Z' },
    { name: '8b-mlx-4bit', full_size: 4800000000, digest: 'sha256:dddddddddddd4444', last_updated: '2026-08-15T00:00:00Z' },
  ],
};
const HUB_DETAIL = { name: 'qwen3', description: '', full_description: '<div><p><strong>See <a href="x">our collection</a> for all versions.</strong></p><p>Qwen3 is the latest generation of large language models in the Qwen series, offering dense and MoE models.</p></div>' };

const HF_LIST = [
  { id: 'unsloth/Qwen3-8B-GGUF', downloads: 118500, likes: 158, pipeline_tag: 'text-generation', tags: ['gguf', 'conversational'] },
  { id: 'unsloth/gemma-3-4b-it-GGUF', downloads: 96200, likes: 80, pipeline_tag: 'image-text-to-text', tags: ['gguf', 'image-text-to-text'] },
  { id: 'nomic-ai/nomic-embed-text-v1.5-GGUF', downloads: 50000, pipeline_tag: 'sentence-similarity', tags: ['gguf'] },
];
const HF_DETAIL = { id: 'unsloth/Qwen3-8B-GGUF', pipeline_tag: 'text-generation', lastModified: '2025-06-08T08:09:00.000Z', gguf: { total: 8190735360, architecture: 'qwen3', context_length: 40960 } };
const HF_TREE = [
  { type: 'file', path: 'Qwen3-8B-Q4_K_M.gguf', size: 5027784512 },
  { type: 'file', path: 'Qwen3-8B-Q8_0.gguf', size: 8709519168 },
  { type: 'file', path: 'Qwen3-8B-UD-Q4_K_XL.gguf', size: 5135722304 },
  { type: 'file', path: 'mmproj-F16.gguf', size: 800000000 },
  { type: 'file', path: 'README.md', size: 1000 },
  { type: 'directory', path: 'BF16' },
  { type: 'file', path: 'BF16/Qwen3-8B-BF16-00001-of-00002.gguf', size: 8000000000 },
  { type: 'file', path: 'BF16/Qwen3-8B-BF16-00002-of-00002.gguf', size: 8388044384 },
];

suite('LocalPilot model gallery: Docker Hub and Hugging Face registries', () => {
  test('Docker Hub lists the ai/ namespace, merges Hub search for the long tail, sorts, pages and infers capabilities', async () => {
    const calls: string[] = [];
    const reg = new DockerHubRegistry('https://hub.test', 60_000, async (url) => {
      calls.push(url);
      if (url.includes('/v2/search/')) {
        return { json: HUB_SEARCH };
      }
      if (url.endsWith('/tags?page_size=100&ordering=last_updated')) {
        return { json: HUB_TAGS };
      }
      if (/\/v2\/repositories\/ai\/qwen3\/$/.test(url)) {
        return { json: HUB_DETAIL };
      }
      return { json: HUB_LIST };
    });
    const all = await reg.search({});
    assert.deepStrictEqual(all.models.map((m) => m.name), ['ai/qwen3', 'ai/smollm2', 'ai/mxbai-embed-large'], 'popular first');
    assert.strictEqual(all.hasMore, false);
    assert.strictEqual(all.models[0].pulls, '888.4K');
    assert.strictEqual(all.models[0].url, 'https://hub.test/r/ai/qwen3');
    assert.deepStrictEqual(all.models[2].capabilities, ['embedding']);
    assert.ok(calls[0].includes('/v2/repositories/ai/?page_size=100&ordering=pull_count'));
    assert.strictEqual(calls.length, 1, 'no Hub search without a query');

    const q = await reg.search({ q: 'qwen', sort: 'name' });
    assert.deepStrictEqual(q.models.map((m) => m.name), ['ai/qwen3', 'ai/qwen3-coder'], 'Hub search adds ai/ repos only, sorted by name');
    assert.strictEqual(q.models[1].description, 'Agentic coder');
    assert.strictEqual(calls.length, 2, 'listing is cached; one search call');
    const emb = await reg.search({ capability: 'embedding' });
    assert.deepStrictEqual(emb.models.map((m) => m.name), ['ai/mxbai-embed-large']);
    const newest = await reg.search({ sort: 'newest' });
    assert.strictEqual(newest.models[0].name, 'ai/smollm2');

    const t = await reg.tags('ai/qwen3');
    assert.strictEqual(t.name, 'ai/qwen3');
    assert.deepStrictEqual(t.tags.map((x) => x.tag), ['0.6b', '8b-mlx-4bit', '8b', '8b-safetensors'], 'latest folded into 8b; sorted by size');
    const b8 = t.tags.find((x) => x.tag === '8b')!;
    assert.strictEqual(b8.model, 'ai/qwen3:8b');
    assert.strictEqual(b8.isLatest, true);
    assert.strictEqual(b8.sizeGb, 4.9);
    assert.strictEqual(b8.digest, 'aaaaaaaaaaaa');
    assert.strictEqual(b8.format, 'GGUF');
    assert.strictEqual(t.tags.find((x) => x.tag === '8b-safetensors')!.format, 'safetensors');
    assert.strictEqual(t.tags.find((x) => x.tag === '8b-mlx-4bit')!.format, 'MLX');
    assert.ok(t.description!.startsWith('Qwen3 is the latest generation'), t.description);
    await assert.rejects(() => reg.tags('ai/../etc'), /Not a Docker Hub/);
  });

  test('Hugging Face searches GGUF repos with capability and sort params, follows cursor paging and groups quants with sizes', async () => {
    const calls: string[] = [];
    const reg = new HuggingFaceRegistry('https://hf.test', 60_000, async (url) => {
      calls.push(url);
      if (url.includes('/tree/main')) {
        return { json: HF_TREE };
      }
      if (url.includes('/api/models/unsloth/Qwen3-8B-GGUF')) {
        return { json: HF_DETAIL };
      }
      const u = new URL(url);
      if (u.searchParams.get('cursor') === 'c2') {
        return { json: [HF_LIST[2]] };
      }
      return { json: HF_LIST.slice(0, 2), link: `<https://hf.test/api/models?search=x&cursor=c2>; rel="next"` };
    });
    assert.strictEqual(reg.searchUrl({ q: 'qwen', capability: 'vision', sort: 'newest' }), 'https://hf.test/api/models?search=qwen&filter=gguf&pipeline_tag=image-text-to-text&sort=lastModified&direction=-1&limit=20');
    assert.strictEqual(reg.searchUrl({ capability: 'embedding', sort: 'name' }), 'https://hf.test/api/models?filter=gguf&pipeline_tag=feature-extraction&sort=id&direction=1&limit=20');

    const p1 = await reg.search({ q: 'qwen' });
    assert.deepStrictEqual(p1.models.map((m) => m.name), ['unsloth/Qwen3-8B-GGUF', 'unsloth/gemma-3-4b-it-GGUF']);
    assert.strictEqual(p1.hasMore, true);
    assert.deepStrictEqual(p1.models[0].sizes, ['8b']);
    assert.deepStrictEqual(p1.models[1].capabilities, ['vision']);
    assert.strictEqual(p1.models[0].pulls, '118.5K');
    assert.strictEqual(p1.models[0].url, 'https://hf.test/unsloth/Qwen3-8B-GGUF');
    const p2 = await reg.search({ q: 'qwen', page: 2 });
    assert.deepStrictEqual(p2.models.map((m) => m.name), ['nomic-ai/nomic-embed-text-v1.5-GGUF']);
    assert.deepStrictEqual(p2.models[0].capabilities, ['embedding']);
    assert.strictEqual(p2.hasMore, false);
    assert.ok(calls[1].includes('cursor=c2'), 'page 2 uses the cursor from page 1');
    assert.strictEqual(calls.length, 2);
    await reg.search({ q: 'qwen', page: 2 });
    assert.strictEqual(calls.length, 2, 'pages are cached');

    const t = await reg.tags('hf.co/unsloth/Qwen3-8B-GGUF');
    assert.strictEqual(t.name, 'unsloth/Qwen3-8B-GGUF');
    assert.deepStrictEqual(t.tags.map((x) => x.tag), ['Q4_K_M', 'UD-Q4_K_XL', 'Q8_0', 'BF16'], 'mmproj skipped, sharded folder summed, sorted by size');
    const q4 = t.tags[0];
    assert.strictEqual(q4.model, 'hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M');
    assert.strictEqual(q4.sizeGb, 4.68);
    assert.strictEqual(q4.context, '40K');
    assert.strictEqual(q4.inputs, 'Text, Image', 'an mmproj file means the repo takes images');
    assert.strictEqual(q4.isLatest, true, 'Q4_K_M is what a bare hf.co pull picks');
    assert.strictEqual(t.tags[3].sizeGb, 15.26);
    assert.strictEqual(t.tags[3].isLatest, false);
    await assert.rejects(() => reg.tags('not-a-repo'), /Not a Hugging Face repository/);
  });

  test('quant grouping, size badges, relative time and README summaries', () => {
    const keys = (paths: string[]) => [...groupQuants(paths.map((p, i) => ({ path: p, size: i + 1 }))).keys()];
    assert.deepStrictEqual(keys(['Qwen3-8B-Q4_K_M.gguf', 'Qwen3-8B-Q8_0.gguf']), ['Q4_K_M', 'Q8_0'], 'shared leading Q is kept');
    assert.deepStrictEqual(keys(['model-q4_k_m.gguf']), ['q4_k_m']);
    assert.deepStrictEqual(keys(['gemma-3-4b-it.gguf']), ['latest'], 'a single unlabelled file is the default');
    assert.deepStrictEqual(keys(['Q4_K_M/a-00001-of-00002.gguf', 'Q4_K_M/a-00002-of-00002.gguf']), ['Q4_K_M']);
    assert.deepStrictEqual(sizesFromName('Qwen3-30B-A3B-Instruct-GGUF'), ['30b-a3b']);
    assert.deepStrictEqual(sizesFromName('gemma-3n-E4B-it-GGUF'), ['e4b']);
    assert.deepStrictEqual(sizesFromName('Llama-3.2-1B-Instruct-GGUF'), ['1b']);
    assert.deepStrictEqual(sizesFromName('nomic-embed-text-v1.5'), []);
    const now = Date.parse('2026-10-24T00:00:00Z');
    assert.strictEqual(relativeTime('2026-10-03T00:00:00Z', now), '3 weeks ago');
    assert.strictEqual(relativeTime('2026-10-23T23:59:30Z', now), 'just now');
    assert.strictEqual(relativeTime('2025-10-01T00:00:00Z', now), '1 year ago');
    assert.strictEqual(relativeTime(undefined, now), undefined);
    assert.strictEqual(firstParagraph(HUB_DETAIL.full_description), 'Qwen3 is the latest generation of large language models in the Qwen series, offering dense and MoE models.');
    assert.strictEqual(firstParagraph(undefined), '');
  });

  test('install references are built per runtime and validated per runtime syntax', () => {
    const hf = { model: 'hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M', tag: 'Q4_K_M' };
    assert.strictEqual(galleryInstallRef('huggingface', 'ollama', hf), 'hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M');
    assert.strictEqual(galleryInstallRef('huggingface', 'lmstudio', hf), 'unsloth/Qwen3-8B-GGUF@q4_k_m');
    assert.strictEqual(galleryInstallRef('huggingface', 'lmstudio', { model: 'hf.co/org/repo', tag: 'latest' }), 'org/repo');
    assert.strictEqual(galleryInstallRef('huggingface', 'docker', hf), undefined);
    assert.strictEqual(galleryInstallRef('ollama', 'ollama', { model: 'qwen3:8b', tag: '8b' }), 'qwen3:8b');
    assert.strictEqual(galleryInstallRef('ollama', 'docker', { model: 'qwen3:8b', tag: '8b' }), undefined);
    assert.strictEqual(galleryInstallRef('docker', 'docker', { model: 'ai/qwen3:8b', tag: '8b' }), 'ai/qwen3:8b');

    assert.ok(isValidInstallRef('ollama', 'hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M'));
    assert.ok(isValidInstallRef('docker', 'ai/qwen3:8b'));
    assert.ok(isValidInstallRef('docker', 'registry.example.com/ns/model:1.0'));
    assert.ok(isValidInstallRef('lmstudio', 'unsloth/Qwen3-8B-GGUF@q4_k_m'));
    assert.ok(isValidInstallRef('lmstudio', 'llama-3.1-8b'));
    for (const [target, bad] of [['docker', 'ai/qwen3 8b'], ['docker', 'ai/../x'], ['lmstudio', 'a/b/c@x'], ['lmstudio', '--mlx'], ['ollama', 'x;rm -rf /']] as const) {
      assert.ok(!isValidInstallRef(target, bad), `${target} ${bad}`);
    }
  });
});
