const esbuild = require("esbuild");
const fs = require('fs');
const { copyAssets } = require('./scripts/assets');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * Copies pdf.js, the KaTeX CSS and fonts and the licence notices into dist/ after every build, watch rebuilds included.
 * @type {import('esbuild').Plugin}
 */
const assetsPlugin = {
	name: 'localpilot-assets',
	setup(build) {
		build.onEnd(() => copyAssets(__dirname));
	},
};

const version = require('./package.json').version;

const common = {
	bundle: true,
	format: 'cjs',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'node',
	target: 'node18',
	logLevel: 'silent',
	define: { __LOCALPILOT_VERSION__: JSON.stringify(version) },
	plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
	// 1. The extension: `vscode` is provided by the host.
	const ext = await esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'], plugins: [...common.plugins, assetsPlugin] });
	// 2. The `localpilot` CLI: same agent core, `vscode` resolved to the Node shim, runnable with plain node.
	const cli = await esbuild.context({
		...common,
		entryPoints: ['src/cli/main.ts'],
		outfile: 'dist/cli.js',
		alias: { vscode: './src/cli/vscodeShim.ts' },
		banner: { js: '#!/usr/bin/env node' },
	});
	// 3. Mermaid for the Markdown reader and the chat: one browser IIFE, loaded by the webviews only when a diagram is shown.
	const mermaid = await esbuild.context({
		entryPoints: ['media/vendor-src/mermaid-entry.js'],
		outfile: 'dist/webview/mermaid.js',
		bundle: true,
		format: 'iife',
		platform: 'browser',
		minify: true,
		legalComments: 'external',
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});
	// 4. The PDF text extractor, forked as a plain Node child (pdf.js needs Node >= 22.13, unlike the CLI bundle).
	const children = fs.existsSync('src/pdf/extractChild.ts')
		? [await esbuild.context({ ...common, entryPoints: ['src/pdf/extractChild.ts'], outfile: 'dist/pdf/extract-child.js', target: 'node22' })]
		: [];
	// 5. The continuity index worker (sql.js in a worker thread), loaded by the extension and the CLI from dist/.
	const continuityWorker = await esbuild.context({ ...common, entryPoints: ['src/continuity/data/index/indexWorker.ts'], outfile: 'dist/continuityWorker.js' });
	const contexts = [ext, cli, ...children, continuityWorker];
	await mermaid.rebuild();
	await mermaid.dispose();
	if (watch) {
		await Promise.all(contexts.map((c) => c.watch()));
	} else {
		await Promise.all(contexts.map((c) => c.rebuild()));
		await Promise.all(contexts.map((c) => c.dispose()));
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
