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
		chat: (payload) => new Promise((resolve) => {
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
		const status = await requestJson(port, 'GET', '/v1/status');
		assert.strictEqual(status.statusCode, 200);
		assert.strictEqual(status.body.jobs.running_count, 2);
		assert.strictEqual(status.body.jobs.queued_count, 1);
		assert.strictEqual(status.body.jobs.max_concurrent, 2);
		assert.deepStrictEqual(status.body.jobs.active.map((job) => job.request_id), ['request-1', 'request-2']);
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
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}

	console.log('server job tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
