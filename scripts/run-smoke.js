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
require(outfile);
