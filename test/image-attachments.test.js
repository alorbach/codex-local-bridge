'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
	collectImageAttachments,
	imagePrompt,
	capabilities,
} = require('../src/codex');

const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

(() => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alorbach-codex-image-attachments-'));
	const imagePath = path.join(tempDir, 'ref.png');
	fs.writeFileSync(imagePath, Buffer.from(tinyPng, 'base64'));

	const fromRefs = collectImageAttachments({
		reference_images: [
			{ b64_json: tinyPng, mime_type: 'image/png', label: 'product' },
			{ b64_json: tinyPng, mime_type: 'image/jpeg', label: 'layout' },
		],
	}, tempDir);
	assert.strictEqual(fromRefs.length, 2);
	assert.strictEqual(fromRefs[0].label, 'product');
	assert.ok(fs.existsSync(fromRefs[0].path));

	const fromPaths = collectImageAttachments({
		referenced_image_paths: [imagePath],
	}, tempDir);
	assert.strictEqual(fromPaths.length, 1);
	assert.strictEqual(fromPaths[0].source_path, path.resolve(imagePath));

	const fromFrames = collectImageAttachments({
		frames: [`data:image/png;base64,${tinyPng}`],
	}, tempDir);
	assert.strictEqual(fromFrames.length, 1);

	const prompt = imagePrompt({ prompt: 'TELE ad', size: '1536x1024', quality: 'high' }, fromRefs);
	assert.ok(prompt.includes('Image 1 (product)'));
	assert.ok(prompt.includes('Image 2 (layout)'));
	assert.ok(prompt.includes('Merge products from Image 1'));

	const caps = capabilities();
	assert.strictEqual(caps.bridge_features.image_reference_attachments, true);

	fs.rmSync(tempDir, { recursive: true, force: true });
	console.log('image-attachments tests passed');
})();
