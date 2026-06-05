'use strict';

const assert = require('assert');
const http = require('http');
const { createServer } = require('../src/server');
const { framesFromPayload, validateRemoteMediaUrl } = require('../src/media-analysis');

const framePng = 'data:image/png;base64,iVBORw0KGgo=';

function requestJson(port, method, pathname, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const data = body ? JSON.stringify(body) : '';
		const req = http.request({
			hostname: '127.0.0.1',
			port,
			path: pathname,
			method,
			headers: {
				Origin: 'http://127.0.0.1:8787',
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(data),
				'X-Alorbach-Bridge-Token': 'test-token',
				...headers,
			},
		}, (res) => {
			let raw = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => {
				raw += chunk;
			});
			res.on('end', () => {
				try {
					resolve({ statusCode: res.statusCode, body: raw ? JSON.parse(raw) : {} });
				} catch (error) {
					reject(error);
				}
			});
		});
		req.on('error', reject);
		if (data) {
			req.write(data);
		}
		req.end();
	});
}

function createMockSecurity(maxBytes = 12 * 1024 * 1024) {
	return {
		MAX_BODY_BYTES: maxBytes,
		createPairingCode: () => '123456',
		createToken: () => 'test-token',
		getPairing: () => ({ token: 'test-token', paired_at: 'now' }),
		getPairings: () => ({ 'http://127.0.0.1:8787': { token: 'test-token', paired_at: 'now' } }),
		isLocalAddress: () => true,
		normalizeOrigin: (origin) => {
			try {
				return new URL(origin).origin;
			} catch (error) {
				return '';
			}
		},
		removePairing: () => {},
		savePairing: () => {},
		validateBridgeToken: (origin, token) => !!origin && token === 'test-token',
	};
}

function jobBody(id, payload) {
	return {
		job_token: 'job-token',
		request_hash: `hash-${id}`,
		request_id: `request-${id}`,
		payload,
	};
}

async function withServer(options, callback) {
	const server = createServer(options);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		await callback(server.address().port);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

(async () => {
	assert.strictEqual(validateRemoteMediaUrl('http://example.com/video.mp4').ok, false);
	assert.strictEqual(validateRemoteMediaUrl('https://127.0.0.1/video.mp4').ok, false);
	assert.strictEqual(validateRemoteMediaUrl('https://example.com/video.mp4').ok, true);
	assert.strictEqual(framesFromPayload({ frames: Array(10).fill(framePng) }).length, 6);

	const video = {
		capabilities: () => ({ enabled: true, models: ['sora-2', 'sora-2-pro'], operations: ['create', 'retrieve', 'download', 'remix', 'delete'] }),
		run: (payload) => {
			if (payload.action === 'download') {
				return { success: true, response: { video_id: payload.video_id, b64_video: Buffer.from('mp4').toString('base64') } };
			}
			return { success: true, response: { id: payload.video_id || 'video-123', status: payload.status || 'queued', model: payload.model || 'sora-2' } };
		},
	};
	const codex = {
		capabilities: () => ({ success: true, bridge_features: { structured_exec_json: true, app_server: true }, codex: { version: 'codex-cli test' } }),
		checkStatus: () => ({ success: true, message: 'ready', details: {} }),
		models: () => ({ success: true, models: { text: ['codex-local:auto'], image: ['codex-local:image'] } }),
		chat: (payload) => Promise.resolve({
			success: true,
			response: {
				choices: [{ message: { role: 'assistant', content: `analyzed ${payload.messages[0].content.length} parts` } }],
				provider_details: {},
			},
		}),
	};
	const mediaAnalysis = require('../src/media-analysis');

	await withServer({ codex, video, mediaAnalysis, security: createMockSecurity(), maxConcurrent: 2 }, async (port) => {
		const capabilities = await requestJson(port, 'GET', '/v1/capabilities');
		assert.strictEqual(capabilities.statusCode, 200);
		assert.strictEqual(capabilities.body.features.structured_exec_json, true);
		assert.strictEqual(capabilities.body.video.enabled, true);

		const models = await requestJson(port, 'GET', '/v1/models');
		assert.strictEqual(models.statusCode, 200);
		assert.deepStrictEqual(models.body.models.video, ['openai-video:sora-2', 'openai-video:sora-2-pro']);

		for (const status of ['queued', 'in_progress', 'completed', 'failed', 'expired']) {
			const result = await requestJson(port, 'POST', '/v1/videos', jobBody(`video-${status}`, { action: 'retrieve', video_id: `video-${status}`, status }));
			assert.strictEqual(result.statusCode, 200);
			assert.strictEqual(result.body.response.status, status);
		}

		const downloaded = await requestJson(port, 'POST', '/v1/videos', jobBody('video-download', { action: 'download', video_id: 'video-completed' }));
		assert.strictEqual(downloaded.statusCode, 200);
		assert.strictEqual(downloaded.body.response.b64_video, Buffer.from('mp4').toString('base64'));

		const analyzed = await requestJson(port, 'POST', '/v1/media/analyze', jobBody('media', { frames: [framePng], prompt: 'What is visible?' }));
		assert.strictEqual(analyzed.statusCode, 200);
		assert.strictEqual(analyzed.body.response.provider_details.media_analysis.frames_analyzed, 1);
	});

	await withServer({
		codex,
		video: {
			capabilities: () => ({ enabled: false, configured: false }),
			run: () => ({ success: false, category: 'configuration', code: 'video_not_configured', message: 'disabled' }),
		},
		mediaAnalysis,
		security: createMockSecurity(),
	}, async (port) => {
		const disabled = await requestJson(port, 'POST', '/v1/videos', jobBody('disabled', { prompt: 'make video' }));
		assert.strictEqual(disabled.statusCode, 503);
		assert.strictEqual(disabled.body.code, 'video_not_configured');
	});

	await withServer({ codex, video, mediaAnalysis, security: createMockSecurity(64) }, async (port) => {
		const oversized = await requestJson(port, 'POST', '/v1/media/analyze', jobBody('large', { frames: ['x'.repeat(200)] }));
		assert.strictEqual(oversized.statusCode, 400);
		assert.strictEqual(oversized.body.message, 'Request body is too large.');
	});

	console.log('multimodal tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
