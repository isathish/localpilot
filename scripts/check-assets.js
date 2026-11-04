// Fails `npm run package` when a vendored asset is missing from dist/ or pdfjs-dist drifted from the pinned version.
const path = require('path');
const { checkAssets } = require('./assets');

const problems = checkAssets(path.resolve(__dirname, '..'));
if (problems.length) {
	console.error(`Vendored assets are not ready:\n${problems.map((p) => `  - ${p}`).join('\n')}\nRun \`node esbuild.js\` after \`npm install\`.`);
	process.exit(1);
}
console.log('Vendored assets OK');
