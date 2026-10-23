const esbuild = require("esbuild");

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
	const ext = await esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] });
	// 2. The `localpilot` CLI: same agent core, `vscode` resolved to the Node shim, runnable with plain node.
	const cli = await esbuild.context({
		...common,
		entryPoints: ['src/cli/main.ts'],
		outfile: 'dist/cli.js',
		alias: { vscode: './src/cli/vscodeShim.ts' },
		banner: { js: '#!/usr/bin/env node' },
	});
	if (watch) {
		await Promise.all([ext.watch(), cli.watch()]);
	} else {
		await Promise.all([ext.rebuild(), cli.rebuild()]);
		await Promise.all([ext.dispose(), cli.dispose()]);
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
