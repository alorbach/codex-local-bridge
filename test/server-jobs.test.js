'use strict';

const assert = require('assert');
const http = require('http');
const { createServer } = require('../src/server');

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

function waitFor(predicate) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		function check() {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() - started > 2000) {
				reject(new Error('Timed out waiting for condition.'));
				return;
			}
			setTimeout(check, 10);
		}
		check();
	});
}

function createMockSecurity() {
	return {
		MAX_BODY_BYTES: 12 * 1024 * 1024,
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

(async () => {
	const pending = [];
	const stateUpdates = [];
	const codex = {
		checkStatus: () => ({ success: true, message: 'ready', details: {} }),
		models: () => ({ success: true, models: { text: ['codex-local:auto'], image: ['codex-local:image'] } }),
		chat: (payload, session = {}) => new Promise((resolve) => {
			if (session.appendSessionOutput) {
				session.appendSessionOutput('stderr', `live output for ${payload.model || 'unknown'}`);
			}
			pending.push({ payload, resolve });
		}),
		images: () => Promise.resolve({ success: true, response: { data: [] } }),
	};
	const server = createServer({
		codex,
		security: createMockSecurity(),
		maxConcurrent: 2,
		onJobState: (snapshot) => stateUpdates.push(JSON.parse(JSON.stringify(snapshot))),
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;

	try {
		const body = (id) => ({
			job_token: 'job-token',
			request_hash: `hash-${id}`,
			request_id: `request-${id}`,
			payload: {
				model: id === 2 ? 'codex-local:gpt-5.4' : 'codex-local:auto',
				messages: [{ role: 'user', content: `secret prompt ${id}` }],
			},
		});

		const first = requestJson(port, 'POST', '/v1/chat', body(1));
		const second = requestJson(port, 'POST', '/v1/chat', body(2));
		const third = requestJson(port, 'POST', '/v1/chat', body(3));

		await waitFor(() => pending.length === 2);
		const page = await new Promise((resolve, reject) => {
			http.get({ hostname: '127.0.0.1', port, path: '/status' }, (res) => {
				let raw = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => {
					raw += chunk;
				});
				res.on('end', () => resolve({ statusCode: res.statusCode, contentType: res.headers['content-type'], body: raw }));
			}).on('error', reject);
		});
		assert.strictEqual(page.statusCode, 200);
		assert.ok(page.contentType.includes('text/html'));
		assert.ok(page.body.includes('Codex Local Bridge'));
		assert.ok(page.body.includes('/v1/status'));
		assert.ok(page.body.includes('<details class="panel span-12">'));
		assert.ok(page.body.includes('<summary>Raw Status</summary>'));
		assert.ok(page.body.includes('white-space: pre-wrap'));
		assert.ok(page.body.includes('overflow-x: hidden'));
		assert.ok(page.body.includes('live-session-output'));
		assert.ok(page.body.includes('scrollTop = output.scrollHeight'));

		const status = await requestJson(port, 'GET', '/v1/status');
		assert.strictEqual(status.statusCode, 200);
		assert.strictEqual(status.body.jobs.running_count, 2);
		assert.strictEqual(status.body.jobs.queued_count, 1);
		assert.strictEqual(status.body.jobs.max_concurrent, 2);
		assert.deepStrictEqual(status.body.jobs.active.map((job) => job.request_id), ['request-1', 'request-2']);
		assert.ok(status.body.jobs.active[0].session_output.includes('live output for codex-local:auto'));
		const serializedState = JSON.stringify(stateUpdates);
		assert.ok(serializedState.includes('request-1'));
		assert.ok(serializedState.includes('codex-local:gpt-5.4'));
		assert.ok(!serializedState.includes('secret prompt'));

		pending[1].resolve({ success: true, response: { id: 'second' } });
		const secondResult = await second;
		assert.strictEqual(secondResult.statusCode, 200);
		await waitFor(() => pending.length === 3);

		pending[0].resolve({ success: true, response: { id: 'first' } });
		pending[2].resolve({ success: true, response: { id: 'third' } });
		const [firstResult, thirdResult] = await Promise.all([first, third]);
		assert.strictEqual(firstResult.statusCode, 200);
		assert.strictEqual(thirdResult.statusCode, 200);

		const failed = requestJson(port, 'POST', '/v1/chat', body('failed'));
		await waitFor(() => pending.length === 4);
		pending[3].resolve({ success: false, message: 'Codex CLI chat request failed.', details: { stderr: 'mock failure' } });
		const failedResult = await failed;
		assert.strictEqual(failedResult.statusCode, 500);
		assert.strictEqual(failedResult.body.debug_help.request_id, 'request-failed');
		assert.ok(failedResult.body.debug_help.status_page.includes('/status'));
		assert.ok(failedResult.body.debug_help.status_json.includes('/v1/status'));
		assert.ok(Array.isArray(failedResult.body.debug_help.checks));

		const failedStatus = await requestJson(port, 'GET', '/v1/status');
		assert.strictEqual(failedStatus.body.jobs.recent[0].status, 'failed');
		assert.strictEqual(failedStatus.body.jobs.recent[0].error_message, 'Codex CLI chat request failed.');
		assert.ok(failedStatus.body.jobs.recent[0].session_output.includes('STDERR:\nmock failure'));
		assert.ok(!JSON.stringify(failedStatus.body.jobs).includes('secret prompt'));
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}

	console.log('server job tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
