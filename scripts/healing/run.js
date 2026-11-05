/**
 * Module smoke runner for the self-healing items.
 *
 *   node scripts/healing/run.js <smoke.ts> [exportName] [--no-check]
 *
 * 1. Type-checks the smoke file together with src/ (a generated tsconfig extending the repo's, written to
 *    out/healing-smoke/); `--no-check` skips this step.
 * 2. Bundles it with esbuild to out/healing-smoke/<name>.js, `vscode` aliased to scripts/vscode-stub.js as in
 *    scripts/run-smoke.js, and `REPO_ROOT` defined as the absolute repo root. Declare it in the smoke file with
 *    `declare const REPO_ROOT: string;` and resolve fixtures from it (path.join(REPO_ROOT, 'scripts/healing/fixtures')),
 *    never relative to __dirname.
 * 3. Requires the bundle and awaits the exported smoke function (`exportName`, or the only exported function)
 *    with a `check(name, cond, detail?)` helper, prints a summary and exits 1 on any failed check.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const noCheck = args.includes('--no-check');
const [file, exportName] = args.filter((a) => a !== '--no-check');
if (!file) {
  console.error('usage: node scripts/healing/run.js <smoke.ts> [exportName] [--no-check]');
  process.exit(2);
}
const entry = path.resolve(process.cwd(), file);
if (!fs.existsSync(entry)) {
  console.error(`No such file: ${entry}`);
  process.exit(2);
}
const name = path.basename(entry).replace(/\.[cm]?tsx?$/, '');
const outDir = path.join(root, 'out', 'healing-smoke');
fs.mkdirSync(outDir, { recursive: true });

if (!noCheck) {
  const tsconfig = path.join(outDir, `tsconfig.${name}.json`);
  fs.writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        extends: path.join(root, 'tsconfig.json'),
        compilerOptions: { noEmit: true, rootDir: root, sourceMap: false },
        include: [path.join(root, 'src'), entry],
        exclude: [path.join(root, 'node_modules'), path.join(root, 'dist'), path.join(root, 'out')],
      },
      null,
      2,
    ),
  );
  const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
  const r = spawnSync(process.execPath, [tsc, '-p', tsconfig], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\nType check failed for ${path.relative(root, entry)}`);
    process.exit(1);
  }
}

const outfile = path.join(outDir, `${name}.js`);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile,
  logLevel: 'warning',
  alias: { vscode: path.join(root, 'scripts', 'vscode-stub.js') },
  define: { REPO_ROOT: JSON.stringify(root) },
});

let failures = 0;
let passes = 0;
function check(label, cond, detail) {
  if (cond) {
    passes++;
    console.log(`  ✔ ${label}`);
  } else {
    failures++;
    console.log(`  ✖ ${label}`, detail ?? '');
  }
}

(async () => {
  const mod = require(outfile);
  let fn;
  if (exportName) {
    fn = mod[exportName];
    if (typeof fn !== 'function') {
      throw new Error(`${path.relative(root, entry)} has no exported function "${exportName}"`);
    }
  } else {
    const fns = Object.keys(mod).filter((k) => typeof mod[k] === 'function');
    if (fns.length !== 1) {
      throw new Error(`${path.relative(root, entry)} exports ${fns.length} functions (${fns.join(', ')}); pass the export name`);
    }
    fn = mod[fns[0]];
  }
  console.log(`\n[${name}]`);
  await fn(check);
  console.log(failures ? `\n${failures} check(s) FAILED, ${passes} passed` : `\nAll ${passes} check(s) passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
