'use strict';

process.env.ALORBACH_CODEX_BINARY = process.execPath;

const assert = require('assert');
const { codexImageFailureFromOutput, codexJsonUnsupported, parseCodexJsonEvents, runCodexAsync } = require('../src/codex');

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

	const oldOutputLimit = process.env.ALORBACH_CODEX_OUTPUT_MAX_CHARS;
	process.env.ALORBACH_CODEX_OUTPUT_MAX_CHARS = '2048';
	try {
		const noisyScript = [
			"process.stdout.write('start-' + 'x'.repeat(8192) + '-end');",
		].join('');
		const noisy = await runCodexAsync(['-e', noisyScript], { timeout: 5000 });
		assert.strictEqual(noisy.status, 0);
		assert.ifError(noisy.error);
		assert.ok(noisy.stdout.startsWith('start-'));
		assert.ok(noisy.stdout.endsWith('-end'));
		assert.ok(noisy.stdout.includes('[truncated'));
		assert.ok(noisy.stdout.length < 2300);
	} finally {
		if (oldOutputLimit === undefined) {
			delete process.env.ALORBACH_CODEX_OUTPUT_MAX_CHARS;
		} else {
			process.env.ALORBACH_CODEX_OUTPUT_MAX_CHARS = oldOutputLimit;
		}
	}

	const rateLimitFailure = codexImageFailureFromOutput('', 'Image generation failed due to rate limiting.', 'C:\\Users\\AL\\.codex\\generated_images');
	assert.strictEqual(rateLimitFailure.success, false);
	assert.strictEqual(rateLimitFailure.code, 'codex_rate_limited');
	assert.strictEqual(rateLimitFailure.category, 'rate_limit');
	assert.strictEqual(rateLimitFailure.retryable, true);
	assert.strictEqual(rateLimitFailure.message, 'Codex image generation was rate limited. Please wait and retry.');
	assert.strictEqual(rateLimitFailure.details.stderr, 'Image generation failed due to rate limiting.');
	assert.strictEqual(rateLimitFailure.details.generated_images_dir, 'C:\\Users\\AL\\.codex\\generated_images');

	const missingOutputFailure = codexImageFailureFromOutput('No image created.', '', '/tmp/generated_images');
	assert.strictEqual(missingOutputFailure.success, false);
	assert.strictEqual(missingOutputFailure.code, 'codex_no_image_output');
	assert.strictEqual(missingOutputFailure.category, 'output_detection');
	assert.strictEqual(missingOutputFailure.retryable, false);
	assert.strictEqual(missingOutputFailure.message, 'Codex CLI completed, but no new generated image file was detected.');
	assert.strictEqual(missingOutputFailure.details.stdout, 'No image created.');
	assert.strictEqual(missingOutputFailure.details.generated_images_dir, '/tmp/generated_images');

	const structured = parseCodexJsonEvents([
		JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
		JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' }, usage: { total_tokens: 123 } }),
		JSON.stringify({ type: 'turn.failed', error: { message: 'model failed' } }),
		'not json',
	].join('\n'));
	assert.strictEqual(structured.events.length, 3);
	assert.deepStrictEqual(structured.finalMessages, ['final answer']);
	assert.deepStrictEqual(structured.usage, { total_tokens: 123 });
	assert.ok(structured.errors.includes('model failed'));
	assert.deepStrictEqual(structured.invalidLines, ['not json']);

	assert.strictEqual(codexJsonUnsupported({ status: 2, stderr: "error: unexpected argument '--json'" }), true);
	assert.strictEqual(codexJsonUnsupported({ status: 1, stderr: 'model failed' }), false);

	console.log('codex runner tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
