import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const outDir = 'build';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));

await esbuild.build({
	entryPoints: ['vs-core/node-runtime/main.ts'],
	bundle: true,
	platform: 'node',
	target: 'node18',
	outfile: path.join(outDir, 'agent-cli.js'),
	format: 'cjs',
	sourcemap: true,
	tsconfig: 'tsconfig.json',
	define: {
		'__AGENT_VERSION__': JSON.stringify(pkg.version),
	},
	external: [],
	banner: {
		js: '#!/usr/bin/env node',
	},
	logLevel: 'info',
	minify: process.argv.includes('--minify'),
	metafile: true,
}).then(result => {
	const outPath = path.join(outDir, 'agent-cli.js');
	fs.chmodSync(outPath, 0o755);

	if (result.metafile) {
		const text = esbuild.analyzeMetafileSync(result.metafile, { verbose: false });
		console.log('\nBundle analysis:');
		console.log(text);
	}

	const stat = fs.statSync(outPath);
	const sizeKB = (stat.size / 1024).toFixed(1);
	console.log(`\nOutput: ${outPath} (${sizeKB} KB)`);

	const templateSrc = 'config.template.yaml';
	const templateDst = path.join(outDir, 'config.template.yaml');
	if (fs.existsSync(templateSrc)) {
		fs.copyFileSync(templateSrc, templateDst);
		console.log(`Copied ${templateSrc} -> ${templateDst}`);
	}
});
