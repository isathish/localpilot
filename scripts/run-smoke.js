// Cross-platform smoke runner: bundles scripts/smoke.ts with `vscode` aliased to a stub, then runs it.
const path = require('path');
const esbuild = require('esbuild');

const outfile = path.resolve(__dirname, '..', 'out', 'smoke.js');
esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, 'smoke.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile,
  logLevel: 'warning',
  alias: { vscode: path.resolve(__dirname, 'vscode-stub.js') },
});
// The PDF extractor child, next to the bundle as in dist/; pdf.js straight from the package.
esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, '..', 'src', 'pdf', 'extractChild.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: path.resolve(__dirname, '..', 'out', 'pdf', 'extract-child.js'),
  logLevel: 'warning',
});
// The continuity index worker, next to the bundle as in dist/, and sql.js's wasm straight from the package.
const workerOut = path.resolve(__dirname, '..', 'out', 'continuityWorker.js');
esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, '..', 'src', 'continuity', 'data', 'index', 'indexWorker.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: workerOut,
  logLevel: 'warning',
});
process.env.LOCALPILOT_CONTINUITY_WORKER ??= workerOut;
process.env.LOCALPILOT_SQLJS_WASM ??= path.resolve(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
process.env.LOCALPILOT_PDFJS_DIR ??= path.resolve(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build');
require(outfile);
