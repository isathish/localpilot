// Vendored webview and PDF assets: copied from node_modules into dist/ by esbuild.js and verified by
// scripts/check-assets.js before packaging. Nothing here is loaded from node_modules at runtime.
const fs = require('fs');
const path = require('path');

const PDFJS_VERSION = '6.5.438';

/** Files the packaged extension must contain, relative to dist/. */
const EXPECTED = [
	'pdfjs/pdf.mjs',
	'pdfjs/pdf.worker.mjs',
	'pdfjs/pdf_viewer.mjs',
	'pdfjs/pdf_viewer.css',
	'pdfjs/images',
	'pdfjs/cmaps/UniJIS-UTF16-H.bcmap',
	'pdfjs/standard_fonts/FoxitSerif.pfb',
	'pdfjs/wasm/openjpeg.wasm',
	'pdfjs/wasm/jbig2.wasm',
	'pdfjs/wasm/qcms_bg.wasm',
	'pdfjs/iccs',
	'pdfjs/LICENSE',
	'webview/katex/katex.min.css',
	'webview/katex/fonts/KaTeX_Main-Regular.woff2',
	'webview/mermaid.js',
	'THIRD_PARTY_NOTICES.txt',
];

const mod = (root, ...p) => path.join(root, 'node_modules', ...p);

function copy(from, to, filter = () => true) {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.cpSync(from, to, { recursive: true, force: true, filter: (src) => !src.endsWith('.map') && filter(src) });
}

function read(file) {
	try {
		return fs.readFileSync(file, 'utf8').trim();
	} catch {
		return '';
	}
}

/** Copies pdf.js (legacy build, shared by the PDF webview and the Node text extractor) and the KaTeX CSS and fonts. */
function copyAssets(root, dist = path.join(root, 'dist')) {
	const pdfjs = mod(root, 'pdfjs-dist');
	const out = path.join(dist, 'pdfjs');
	copy(path.join(pdfjs, 'legacy', 'build', 'pdf.min.mjs'), path.join(out, 'pdf.mjs'));
	// The Node fake worker resolves `./pdf.worker.mjs`, so the name must stay exactly this.
	copy(path.join(pdfjs, 'legacy', 'build', 'pdf.worker.min.mjs'), path.join(out, 'pdf.worker.mjs'));
	copy(path.join(pdfjs, 'legacy', 'web', 'pdf_viewer.mjs'), path.join(out, 'pdf_viewer.mjs'));
	copy(path.join(pdfjs, 'legacy', 'web', 'pdf_viewer.css'), path.join(out, 'pdf_viewer.css'));
	copy(path.join(pdfjs, 'legacy', 'web', 'images'), path.join(out, 'images'));
	for (const dir of ['cmaps', 'standard_fonts', 'iccs']) {
		copy(path.join(pdfjs, dir), path.join(out, dir));
	}
	// Document scripting is never enabled, so the QuickJS sandbox is left out.
	copy(path.join(pdfjs, 'wasm'), path.join(out, 'wasm'), (src) => !/quickjs/i.test(path.basename(src)));
	copy(path.join(pdfjs, 'LICENSE'), path.join(out, 'LICENSE'));

	const katex = mod(root, 'katex', 'dist');
	const kout = path.join(dist, 'webview', 'katex');
	copy(path.join(katex, 'katex.min.css'), path.join(kout, 'katex.min.css'));
	fs.mkdirSync(path.join(kout, 'fonts'), { recursive: true });
	for (const f of fs.readdirSync(path.join(katex, 'fonts')).filter((f) => f.endsWith('.woff2'))) {
		fs.copyFileSync(path.join(katex, 'fonts', f), path.join(kout, 'fonts', f));
	}
	writeNotices(root, dist);
}

function writeNotices(root, dist) {
	const section = (title, body) => (body ? `${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n\n${body}\n` : '');
	const subLicenses = ['wasm', 'standard_fonts', 'iccs']
		.flatMap((dir) =>
			fs
				.readdirSync(mod(root, 'pdfjs-dist', dir))
				.filter((f) => f.startsWith('LICENSE') && !/QUICKJS/i.test(f))
				.map((f) => section(`pdfjs-dist/${dir}/${f}`, read(mod(root, 'pdfjs-dist', dir, f))))
		)
		.join('\n');
	const parts = [
		'LocalPilot ships the following third-party components in dist/. Each is listed with its licence.\n',
		section(`pdfjs-dist ${PDFJS_VERSION} (Apache-2.0), dist/pdfjs`, read(mod(root, 'pdfjs-dist', 'LICENSE'))),
		subLicenses,
		section('mermaid (MIT), dist/webview/mermaid.js', read(mod(root, 'mermaid', 'LICENSE'))),
		section('Licences of the code bundled into dist/webview/mermaid.js', read(path.join(dist, 'webview', 'mermaid.js.LEGAL.txt'))),
		section(
			'DOMPurify (bundled in mermaid.js). Dual-licensed MPL-2.0 OR Apache-2.0; LocalPilot uses it under Apache-2.0.',
			read(mod(root, 'dompurify', 'LICENSE'))
		),
		section('KaTeX (MIT), dist/webview/katex', read(mod(root, 'katex', 'LICENSE'))),
	];
	fs.writeFileSync(path.join(dist, 'THIRD_PARTY_NOTICES.txt'), parts.filter(Boolean).join('\n'));
}

/** Missing files under dist/ and a pdfjs-dist version drift, as readable problems. */
function checkAssets(root, dist = path.join(root, 'dist')) {
	const expected = fs.existsSync(path.join(root, 'src', 'pdf', 'extractChild.ts')) ? [...EXPECTED, 'pdf/extract-child.js'] : EXPECTED;
	const problems = expected.filter((f) => !fs.existsSync(path.join(dist, f))).map((f) => `missing dist/${f}`);
	let version = '';
	try {
		version = JSON.parse(fs.readFileSync(mod(root, 'pdfjs-dist', 'package.json'), 'utf8')).version;
	} catch {
		problems.push('pdfjs-dist is not installed');
	}
	if (version && version !== PDFJS_VERSION) {
		problems.push(`pdfjs-dist is ${version}, expected ${PDFJS_VERSION} (the copy step relies on its file layout)`);
	}
	return problems;
}

module.exports = { PDFJS_VERSION, EXPECTED, copyAssets, checkAssets };
