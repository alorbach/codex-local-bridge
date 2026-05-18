'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildChatPrompt } = require('../src/codex');

const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

(() => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alorbach-codex-prompt-test-'));
	const dataUrl = `data:image/png;base64,${tinyPng}`;
	const result = buildChatPrompt([
		{
			role: 'user',
			content: [
				{ type: 'input_text', text: 'Describe the attached image.' },
				{ type: 'input_image', image_url: dataUrl },
			],
		},
	], 123, tempDir);

	assert.ok(result.prompt.includes('Describe the attached image.'));
	assert.ok(result.prompt.includes('Attached image 1: image/png'));
	assert.ok(!result.prompt.includes(dataUrl));
	assert.ok(!result.prompt.includes(tinyPng));
	assert.strictEqual(result.attachments.length, 1);
	assert.strictEqual(result.attachments[0].mime, 'image/png');
	assert.ok(fs.existsSync(result.attachments[0].path));
	assert.strictEqual(path.extname(result.attachments[0].path), '.png');

	fs.rmSync(tempDir, { recursive: true, force: true });
	console.log('codex prompt tests passed');
})()
