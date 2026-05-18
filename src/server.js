'use strict';

const http = require('http');
const codex = require('./codex');
const { attachDebugHelp } = require('./debug-help');
const { JobManager, clampMaxConcurrent } = require('./job-manager');
const security = require('./security');
const { statusPageHtml } = require('./status-page');

let pairingCode = security.createPairingCode();

function maxConcurrentJobs() {
	return clampMaxConcurrent(process.env.ALORBACH_CODEX_MAX_CONCURRENT_JOBS || 2);
}

function sendJobState(jobManager) {
	if (process.send) {
		process.send({ type: 'job-state', jobs: jobManager.snapshot() });
	}
}

function sendJobStateSnapshot(snapshot) {
	if (process.send) {
		process.send({ type: 'job-state', jobs: snapshot });
	}
}

function createStatusEvents() {
	const clients = new Set();
	return {
		add(res, initialJobs) {
			clients.add(res);
			res.writeHead(200, {
				'Content-Type': 'text/event-stream; charset=utf-8',
				'Cache-Control': 'no-store, no-transform',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no',
			});
			res.write('retry: 3000\n\n');
			this.send(res, 'jobs', initialJobs);
			res.on('close', () => {
				clients.delete(res);
			});
		},
		broadcast(event, payload) {
			for (const res of clients) {
				this.send(res, event, payload);
			}
		},
		send(res, event, payload) {
			res.write(`event: ${event}\n`);
			res.write(`data: ${JSON.stringify(payload)}\n\n`);
		},
	};
}

function createJobManager(options = {}) {
	let manager = null;
	manager = new JobManager({
		maxConcurrent: options.maxConcurrent || maxConcurrentJobs(),
		onChange: options.onJobState || (() => sendJobState(manager)),
	});
	return manager;
}

function sendJson(res, statusCode, payload, origin) {
	const headers = {
		'Content-Type': 'application/json',
		'Cache-Control': 'no-store',
	};
	if (origin) {
		headers['Access-Control-Allow-Origin'] = origin;
		headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Alorbach-Bridge-Token, X-Alorbach-Request-Id';
		headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
		headers.Vary = 'Origin';
	}
	res.writeHead(statusCode, headers);
	res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
	res.writeHead(statusCode, {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
	});
	res.end(html);
}

function sendErrorJson(req, res, statusCode, payload, origin, options = {}) {
	sendJson(res, statusCode, attachDebugHelp(req, payload, {
		...options,
		statusCode,
	}), origin);
}

function readBody(req, maxBytes) {
	return new Promise((resolve, reject) => {
		let body = '';
		let size = 0;
		req.setEncoding('utf8');
		req.on('data', (chunk) => {
			size += Buffer.byteLength(chunk, 'utf8');
			if (size > maxBytes) {
				reject(new Error('Request body is too large.'));
				req.destroy();
				return;
			}
			body += chunk;
		});
		req.on('end', () => {
			if (!body.trim()) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(body));
			} catch (error) {
				reject(new Error('Request body was not valid JSON.'));
			}
		});
		req.on('error', reject);
	});
}

function exposeOrigin(req, bridgeSecurity) {
	return bridgeSecurity.normalizeOrigin(req.headers.origin || '');
}

function pairedOriginForCors(req, bridgeSecurity) {
	const origin = exposeOrigin(req, bridgeSecurity);
	return origin && bridgeSecurity.getPairing(origin) ? origin : '';
}

function requirePairing(req, res, bridgeSecurity) {
	const origin = exposeOrigin(req, bridgeSecurity);
	const token = req.headers['x-alorbach-bridge-token'];
	if (!origin || !bridgeSecurity.validateBridgeToken(origin, token)) {
		sendErrorJson(req, res, 403, { success: false, message: 'This WordPress origin is not paired with the local Codex bridge.' }, origin);
		return null;
	}
	return origin;
}

function modelFromPayload(payload, fallback) {
	return String((payload && payload.model) || fallback || 'codex-local:auto');
}

async function route(req, res, context) {
	const bridgeSecurity = context.security;
	const codexAdapter = context.codex;
	const jobManager = context.jobManager;
	const origin = exposeOrigin(req, bridgeSecurity);
	if (!bridgeSecurity.isLocalAddress(req)) {
		sendErrorJson(req, res, 403, { success: false, message: 'Local Codex bridge only accepts localhost requests.' });
		return;
	}

	if (req.method === 'OPTIONS') {
		sendJson(res, 204, {}, origin || pairedOriginForCors(req, bridgeSecurity));
		return;
	}

	const url = new URL(req.url, 'http://127.0.0.1');
	if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/status')) {
		sendHtml(res, 200, statusPageHtml());
		return;
	}

	if (req.method === 'GET' && url.pathname === '/v1/status') {
		const status = codexAdapter.checkStatus();
		sendJson(res, status.success ? 200 : 503, {
			...status,
			bridge: {
				version: require('../package.json').version,
				paired_origins: Object.keys(bridgeSecurity.getPairings()),
			},
			jobs: jobManager.snapshot(),
		}, origin || pairedOriginForCors(req, bridgeSecurity));
		return;
	}

	if (req.method === 'GET' && url.pathname === '/v1/status/events') {
		context.statusEvents.add(res, jobManager.snapshot());
		return;
	}

	if (req.method === 'GET' && url.pathname === '/v1/models') {
		const pairedOrigin = requirePairing(req, res, bridgeSecurity);
		if (!pairedOrigin) {
			return;
		}
		sendJson(res, 200, codexAdapter.models(), pairedOrigin);
		return;
	}

	if (req.method !== 'POST') {
		sendErrorJson(req, res, 405, { success: false, message: 'Method not allowed.' }, origin);
		return;
	}

	let body;
	try {
		body = await readBody(req, bridgeSecurity.MAX_BODY_BYTES || security.MAX_BODY_BYTES);
	} catch (error) {
		sendErrorJson(req, res, 400, { success: false, message: error.message || 'Invalid request.' }, origin);
		return;
	}

	if (url.pathname === '/v1/pair') {
		const safeOrigin = bridgeSecurity.normalizeOrigin(body.origin || origin);
		if (!safeOrigin) {
			sendErrorJson(req, res, 400, { success: false, message: 'A valid WordPress origin is required.' }, origin);
			return;
		}
		if (String(body.pairing_code || '') !== pairingCode) {
			sendErrorJson(req, res, 403, { success: false, message: 'Pairing code did not match the local tray app.' }, safeOrigin);
			return;
		}
		const token = bridgeSecurity.createToken();
		bridgeSecurity.savePairing(safeOrigin, token);
		pairingCode = bridgeSecurity.createPairingCode();
		if (process.send) {
			process.send({ type: 'pairing-code', pairingCode });
		}
		sendJson(res, 200, { success: true, origin: safeOrigin, token }, safeOrigin);
		return;
	}

	if (url.pathname === '/v1/unpair') {
		const pairedOrigin = requirePairing(req, res, bridgeSecurity);
		if (!pairedOrigin) {
			return;
		}
		bridgeSecurity.removePairing(pairedOrigin);
		sendJson(res, 200, { success: true }, pairedOrigin);
		return;
	}

	const pairedOrigin = requirePairing(req, res, bridgeSecurity);
	if (!pairedOrigin) {
		return;
	}
	if (!body.job_token || !body.request_hash || !body.request_id) {
		sendErrorJson(req, res, 400, { success: false, message: 'Signed WordPress job token, request hash, and request id are required.' }, pairedOrigin, { requestId: body.request_id });
		return;
	}

	if (url.pathname === '/v1/chat') {
		const result = await jobManager.run({
			requestId: body.request_id,
			type: 'chat',
			model: modelFromPayload(body.payload, 'codex-local:auto'),
		}, (session) => codexAdapter.chat(body.payload || {}, session));
		if (!result.success) {
			sendErrorJson(req, res, 500, result, pairedOrigin, { requestId: body.request_id, route: '/v1/chat' });
			return;
		}
		sendJson(res, 200, result, pairedOrigin);
		return;
	}
	if (url.pathname === '/v1/images') {
		const result = await jobManager.run({
			requestId: body.request_id,
			type: 'images',
			model: modelFromPayload(body.payload, 'codex-local:image'),
		}, (session) => codexAdapter.images(body.payload || {}, session));
		if (!result.success) {
			sendErrorJson(req, res, 500, result, pairedOrigin, { requestId: body.request_id, route: '/v1/images' });
			return;
		}
		sendJson(res, 200, result, pairedOrigin);
		return;
	}
	sendErrorJson(req, res, 404, { success: false, message: 'Unknown local bridge route.' }, pairedOrigin, { requestId: body.request_id });
}

function createServer(options = {}) {
	const statusEvents = createStatusEvents();
	const onJobState = (snapshot) => {
		if (typeof options.onJobState === 'function') {
			options.onJobState(snapshot);
		} else {
			sendJobStateSnapshot(snapshot);
		}
		statusEvents.broadcast('jobs', snapshot);
	};
	const context = {
		codex: options.codex || codex,
		security: options.security || security,
		jobManager: options.jobManager || createJobManager({ ...options, onJobState }),
		statusEvents,
	};
	const server = http.createServer((req, res) => {
		route(req, res, context).catch((error) => {
			sendErrorJson(req, res, 500, { success: false, message: error && error.message ? error.message : 'Unexpected bridge failure.' }, exposeOrigin(req, context.security));
		});
	});
	server.jobManager = context.jobManager;
	return server;
}

function startServer(options = {}) {
	const requestedPort = Number(options.port || process.env.ALORBACH_CODEX_BRIDGE_PORT || 8765);
	const server = createServer(options);
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(requestedPort, '127.0.0.1', () => {
			server.off('error', reject);
			sendJobState(server.jobManager);
			resolve({ server, port: server.address().port, pairingCode });
		});
	});
}

if (require.main === module) {
	if (process.argv.includes('--check')) {
		const status = codex.checkStatus();
		process.stdout.write(JSON.stringify(status, null, 2) + '\n');
		process.exit(status.success ? 0 : 1);
	}
	const portArg = process.argv.find((arg) => arg.indexOf('--port=') === 0);
	const port = portArg ? Number(portArg.replace('--port=', '')) : undefined;
	startServer({ port }).then((result) => {
		if (process.send) {
			process.send({ type: 'ready', port: result.port, pairingCode });
		}
		process.stdout.write(`Codex Local Bridge listening on http://127.0.0.1:${result.port}\n`);
		process.stdout.write(`Pairing code: ${pairingCode}\n`);
	}).catch((error) => {
		if (process.send) {
			process.send({ type: 'error', message: error && error.message ? error.message : String(error) });
		}
		process.stderr.write((error && error.message ? error.message : String(error)) + '\n');
		process.exit(1);
	});
}

module.exports = {
	createServer,
	createJobManager,
	getPairingCode: () => pairingCode,
	startServer,
};
