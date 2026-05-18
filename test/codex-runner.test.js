'use strict';

process.env.ALORBACH_CODEX_BINARY = process.execPath;

const assert = require('assert');
const { runCodexAsync } = require('../src/codex');

(async () => {
	const input = `start\n${'x'.repeat(128 * 1024)}\nend`;
	const script = [
		"let input = '';",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', (chunk) => { input += chunk; });",
		"process.stdin.on('end', () => {",
		"  process.stdout.write(JSON.stringify({",
		"    argv: process.argv.slice(1),",
		"    inputLength: input.length,",
		"    startsWith: input.slice(0, 5),",
		"    endsWith: input.slice(-3)",
		"  }));",
		"});",
	].join('');

	const result = await runCodexAsync(['-e', script, 'exec', '--skip-git-repo-check', '-'], {
		input,
		timeout: 5000,
	});

	assert.strictEqual(result.status, 0);
	assert.ifError(result.error);
	const payload = JSON.parse(result.stdout);
	assert.deepStrictEqual(payload.argv.slice(-3), ['exec', '--skip-git-repo-check', '-']);
	assert.strictEqual(payload.inputLength, input.length);
	assert.strictEqual(payload.startsWith, 'start');
	assert.strictEqual(payload.endsWith, 'end');

	console.log('codex runner tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
