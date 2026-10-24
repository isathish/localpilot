import * as assert from 'assert';
import { isValidOllamaModelRef, OllamaRegistry, parseOllamaSearchHtml, parseOllamaTagsHtml } from '../providers/ollamaRegistry';

/** Trimmed copy of the markup ollama.com/search renders (two local models, one cloud-only). */
const SEARCH_HTML = `
<p data-result-count="20" data-has-more="true" class="text-[13px]">20+ models</p>
<ul role="list">
<li class="border-b border-black/[0.08]">
  <a href="/library/qwen3.5" class="group flex">
    <div class="min-w-0 flex-1">
      <h2 class="truncate text-xl" title="qwen3.5"><span>qwen3.5</span></h2>
      <p class="mt-1 max-w-2xl truncate" title="Qwen 3.5 is a family of open-source multimodal models &amp; more.">Qwen 3.5 is a family of open-source multimodal models &amp; more.</p>
      <div class="mt-3 flex flex-wrap"><span class="inline-flex items-center rounded-md bg-indigo-50 px-2">vision</span><span class="inline-flex items-center rounded-md bg-indigo-50 px-2">tools</span><span class="inline-flex items-center rounded-md bg-indigo-50 px-2">thinking</span>
        <span class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2">0.8b</span>
        <span class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2">9b</span>
        <span class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2">122b</span>
      </div>
    </div>
    <span class="inline-flex shrink-0 items-center gap-1.5 tabular-nums" title="23,265,336 downloads"><svg class="h-[1.15em]"><path d="M3 16.5"/></svg><span>23.3M</span></span>
  </a>
</li>
<li class="border-b border-black/[0.08]">
  <a href="/library/glm-5.3" class="group flex">
    <div class="min-w-0 flex-1">
      <h2 class="truncate" title="glm-5.3"><span>glm-5.3</span></h2>
      <p class="mt-1" title="Frontier reasoning model.">Frontier reasoning model.</p>
      <div class="mt-3 flex"><span class="inline-flex items-center rounded-md bg-indigo-50">tools</span><span class="inline-flex items-center rounded-md bg-indigo-50">thinking</span> <span class="inline-flex items-center rounded-md bg-cyan-50">cloud</span></div>
    </div>
  </a>
</li>
<li class="border-b">
  <a href="/library/nomic-embed-text" class="group flex">
    <div><h2 title="nomic-embed-text"><span>nomic-embed-text</span></h2><p title="A high-performing open embedding model.">A high-performing open embedding model.</p>
    <div><span class="inline-flex items-center rounded-md bg-indigo-50">embedding</span></div></div>
    <span class="inline-flex shrink-0 items-center" title="41,200,000 downloads"><svg></svg><span>41.2M</span></span>
  </a>
</li>
<li hx-get="/search?page=2" hx-trigger="revealed" hx-swap="outerHTML" hx-target="this"><span class="sr-only">Loading…</span></li>
</ul>`;

/** Trimmed copy of ollama.com/library/gpt-oss/tags: `latest` aliasing a concrete tag, a bigger tag and two cloud tags. */
const TAGS_HTML = (name: string) => `
<section>
<div class="group px-4 py-3">
  <a href="/library/${name}:latest" class="md:hidden flex flex-col"><div><span class="group-hover:underline">${name}:latest</span></div>
    <div class="text-neutral-500"><span><span class="font-mono">f38aa0c53da5</span> • 14GB • 128K context window • <span class="hidden sm:inline">Text input • 2 weeks ago</span></span></div></a>
  <div class="hidden md:flex"><a href="/library/${name}:latest" class="group-hover:underline">${name}:latest</a><input class="command hidden" value="${name}:latest" /></div>
</div>
<div class="group px-4 py-3">
  <a href="/library/${name}:20b" class="md:hidden flex flex-col"><div><span class="group-hover:underline">${name}:20b</span><span class="ml-2 badge">latest</span></div>
    <div class="text-neutral-500"><span><span class="font-mono">f38aa0c53da5</span> • 14GB • 128K context window • <span class="hidden sm:inline">Text input • 2 weeks ago</span></span></div></a>
  <div class="hidden md:flex"><a href="/library/${name}:20b" class="group-hover:underline">${name}:20b</a></div>
</div>
<div class="group px-4 py-3">
  <a href="/library/${name}:120b" class="md:hidden flex flex-col"><div><span>${name}:120b</span></div>
    <div><span><span class="font-mono">714d86958b6e</span> • 65GB • 128K context window • <span>Text, Image input • 3 months ago</span></span></div></a>
</div>
<div class="group px-4 py-3">
  <a href="/library/${name}:20b-cloud" class="md:hidden flex flex-col"><div><span>${name}:20b-cloud</span></div>
    <div><span><span class="font-mono">875e8e3a629a</span> • Low Usage • 128K context window • <span>Text input • 1 year ago</span></span></div></a>
</div>
<div class="group px-4 py-3">
  <a href="/library/${name}:0.5b" class="md:hidden flex flex-col"><div><span>${name}:0.5b</span></div>
    <div><span><span class="font-mono">0a1b2c3d4e5f</span> • 398MB • 32K context window • <span>Text input • 1 year ago</span></span></div></a>
</div>
<a href="/library/other-model:1b">not this model</a>
</section>`;

suite('LocalPilot Ollama library (model gallery)', () => {
  test('search page parses names, descriptions, capabilities, sizes, downloads, cloud flag and paging', () => {
    const { models, hasMore } = parseOllamaSearchHtml(SEARCH_HTML);
    assert.strictEqual(hasMore, true);
    assert.deepStrictEqual(models.map((m) => m.name), ['qwen3.5', 'glm-5.3', 'nomic-embed-text']);
    const [qwen, glm, nomic] = models;
    assert.strictEqual(qwen.description, 'Qwen 3.5 is a family of open-source multimodal models & more.');
    assert.deepStrictEqual(qwen.capabilities, ['vision', 'tools', 'thinking']);
    assert.deepStrictEqual(qwen.sizes, ['0.8b', '9b', '122b'], 'the download counter is not a size');
    assert.strictEqual(qwen.pulls, '23.3M');
    assert.strictEqual(qwen.pullsCount, 23265336);
    assert.strictEqual(qwen.cloud, false);
    assert.strictEqual(qwen.url, 'https://ollama.com/library/qwen3.5');
    assert.strictEqual(glm.cloud, true, 'cloud badge without any local size → cloud-only');
    assert.deepStrictEqual(glm.sizes, []);
    assert.strictEqual(glm.pulls, undefined);
    assert.deepStrictEqual(nomic.capabilities, ['embedding']);
    assert.strictEqual(nomic.pulls, '41.2M');
    assert.deepStrictEqual(parseOllamaSearchHtml('<ul></ul><p>No models found.</p>'), { models: [], hasMore: false });
  });

  test('tags page parses size, context, inputs, digest, cloud tags and folds :latest into its concrete twin', () => {
    const tags = parseOllamaTagsHtml('gpt-oss', TAGS_HTML('gpt-oss'));
    assert.deepStrictEqual(tags.map((t) => t.model), ['gpt-oss:20b', 'gpt-oss:120b', 'gpt-oss:20b-cloud', 'gpt-oss:0.5b'], 'latest alias removed, other models ignored');
    const [b20, b120, cloud, small] = tags;
    assert.strictEqual(b20.isLatest, true);
    assert.strictEqual(b20.tag, '20b');
    assert.strictEqual(b20.sizeGb, 14);
    assert.strictEqual(b20.context, '128K');
    assert.strictEqual(b20.inputs, 'Text');
    assert.strictEqual(b20.updated, '2 weeks ago');
    assert.strictEqual(b20.digest, 'f38aa0c53da5');
    assert.strictEqual(b20.cloud, false);
    assert.strictEqual(b120.isLatest, false);
    assert.strictEqual(b120.sizeGb, 65);
    assert.strictEqual(b120.inputs, 'Text, Image');
    assert.strictEqual(cloud.cloud, true);
    assert.strictEqual(cloud.sizeGb, undefined, 'usage tiers are not sizes');
    assert.strictEqual(small.sizeGb, 0.39, 'MB converted to GB');
    assert.strictEqual(small.context, '32K');
  });

  test('model references accept what `ollama pull` accepts and reject shell-ish input', () => {
    for (const ok of ['qwen3', 'qwen3:8b', 'qwen2.5-coder:7b-instruct-q4_K_M', 'user/model:tag', 'hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M', 'registry.example.com/ns/name:1.0']) {
      assert.ok(isValidOllamaModelRef(ok), ok);
    }
    for (const bad of ['', 'bad name', 'a:b:c', '../x', '-leading', 'name:', 'a/b/c/d/e', 'x;rm -rf /', 'a'.repeat(201)]) {
      assert.ok(!isValidOllamaModelRef(bad), JSON.stringify(bad));
    }
  });

  test('registry builds the site’s own search URLs, caches pages and refuses tag lookups for non-library names', async () => {
    const calls: string[] = [];
    const reg = new OllamaRegistry('https://example.test', 60_000, async (url) => {
      calls.push(url);
      return url.includes('/tags') ? TAGS_HTML('gpt-oss') : SEARCH_HTML;
    });
    assert.strictEqual(reg.searchUrl({ q: 'coder' }), 'https://example.test/search?q=coder&c=local');
    assert.strictEqual(reg.searchUrl({ q: ' a b ', capability: 'vision', sort: 'newest', page: 3 }), 'https://example.test/search?q=a+b&c=local&c=vision&o=newest&page=3');
    assert.strictEqual(reg.searchUrl({ sort: 'popular', page: 1 }), 'https://example.test/search?q=&c=local', 'defaults are omitted');

    const r1 = await reg.search({ q: 'qwen' });
    assert.deepStrictEqual(r1.query, { q: 'qwen', capability: '', sort: 'popular', page: 1 });
    assert.strictEqual(r1.models.length, 3);
    assert.strictEqual(r1.hasMore, true);
    const r2 = await reg.search({ q: 'qwen ' });
    assert.strictEqual(r2.models.length, 3);
    assert.strictEqual(calls.length, 1, 'same query (trimmed) is served from cache');
    await reg.search({ q: 'qwen', page: 2 });
    assert.strictEqual(calls.length, 2);
    assert.ok(calls[1].endsWith('page=2'));

    const t = await reg.tags('library/gpt-oss');
    assert.strictEqual(t.name, 'gpt-oss');
    assert.strictEqual(t.tags.length, 4);
    assert.strictEqual(calls[2], 'https://example.test/library/gpt-oss/tags');
    await reg.tags('gpt-oss');
    assert.strictEqual(calls.length, 3, 'tags are cached too');
    await assert.rejects(() => reg.tags('gpt-oss:20b'), /Not a library model name/);
    await assert.rejects(() => reg.tags('../etc'), /Not a library model name/);

    reg.clearCache();
    await reg.search({ q: 'qwen' });
    assert.strictEqual(calls.length, 4);
  });

  test('registry surfaces fetch failures instead of swallowing them', async () => {
    const reg = new OllamaRegistry('https://example.test', 1000, async () => {
      throw new Error('fetch failed');
    });
    await assert.rejects(() => reg.search({ q: 'x' }), /fetch failed/);
    await assert.rejects(() => reg.tags('x'), /fetch failed/);
  });
});
