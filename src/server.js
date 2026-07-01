'use strict';

const http = require('http');
const codex = require('./codex');
const { attachDebugHelp } = require('./debug-help');
const { JobManager, clampMaxConcurrent } = require('./job-manager');
const mediaAnalysis = require('./media-analysis');
const security = require('./security');
const { statusPageHtml } = require('./status-page');
const video = require('./video');
const packageInfo = require('../package.json');
const { appendLog, safeError, safeProcessSend } = require('./diagnostics');

let pairingCode = security.createPairingCode();

function maxConcurrentJobs() {
	return clampMaxConcurrent(process.env.ALORBACH_CODEX_MAX_CONCURRENT_JOBS || 2);
}

function sendJobState(jobManager) {
	safeProcessSend({ type: 'job-state', jobs: jobManager.snapshot() }, { logName: 'server' });
}

function sendJobStateSnapshot(snapshot) {
	safeProcessSend({ type: 'job-state', jobs: snapshot }, { logName: 'server' });
}

function sseHeaders(origin = '') {
	const headers = {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-store, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	};
	if (origin) {
		headers['Access-Control-Allow-Origin'] = origin;
		headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Alorbach-Bridge-Token, X-Alorbach-Request-Id';
		headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
		headers.Vary = 'Origin';
	}
	return headers;
}

function createStatusEvents() {
	const clients = new Set();
	function remove(client, reason = '') {
		if (!client || client.closed) {
			return;
		}
		client.closed = true;
		if (client.heartbeatTimer) {
			clearInterval(client.heartbeatTimer);
			client.heartbeatTimer = null;
		}
		clients.delete(client);
		if (reason) {
			appendLog('server', 'Status event stream closed.', { reason });
		}
	}
	return {
		add(res, options = {}) {
			const client = {
				res,
				events: new Set(options.events || ['jobs']),
				heartbeatTimer: null,
				closed: false,
			};
			clients.add(client);
			res.on('close', () => remove(client));
			res.on('error', (error) => remove(client, error && error.message ? error.message : 'response error'));
			try {
				res.writeHead(200, sseHeaders(options.origin || ''));
				res.write('retry: 3000\n\n');
			} catch (error) {
				remove(client, error && error.message ? error.message : 'initial write failed');
				return;
			}
			for (const [event, payload] of options.initialEvents || []) {
				this.send(client, event, payload);
			}
			if (client.closed) {
				return;
			}
			client.heartbeatTimer = setInterval(() => {
				this.send(client, 'heartbeat', { time: new Date().toISOString() });
			}, 15000);
			if (typeof client.heartbeatTimer.unref === 'function') {
				client.heartbeatTimer.unref();
			}
		},
		broadcast(event, payload) {
			for (const client of clients) {
				this.send(client, event, payload);
			}
		},
		send(client, event, payload) {
			if (!client.events.has(event) && event !== 'heartbeat') {
				return;
			}
			if (client.closed || client.res.destroyed || client.res.writableEnded) {
				remove(client);
				return;
			}
			let data;
			try {
				data = JSON.stringify(payload);
			} catch (error) {
				appendLog('server', 'Status event payload could not be serialized.', { event, error: safeError(error) });
				return;
			}
			try {
				client.res.write(`event: ${event}\n`);
				client.res.write(`data: ${data}\n\n`);
			} catch (error) {
				remove(client, error && error.message ? error.message : 'write failed');
			}
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
		let rejected = false;
		req.setEncoding('utf8');
		req.on('data', (chunk) => {
			size += Buffer.byteLength(chunk, 'utf8');
			if (size > maxBytes) {
				if (!rejected) {
					rejected = true;
					reject(new Error('Request body is too large.'));
				}
				return;
			}
			body += chunk;
		});
		req.on('end', () => {
			if (rejected) {
				return;
			}
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

function capabilitiesPayload(context) {
	const codexCapabilities = context.codex.capabilities ? context.codex.capabilities() : { success: true, bridge_features: {} };
	return {
		success: true,
		bridge: {
			version: packageInfo.version,
		},
		codex: codexCapabilities.codex || {},
		asr: codexCapabilities.asr || {},
		features: codexCapabilities.bridge_features || {},
		video: context.video.capabilities ? context.video.capabilities() : { enabled: false },
		media_analysis: context.mediaAnalysis.capabilities ? context.mediaAnalysis.capabilities() : { enabled: false },
	};
}

function statusPayload(context, options = {}) {
	const status = context.codex.checkStatus();
	const bridge = {
		version: packageInfo.version,
	};
	if (options.includePairedOrigins !== false) {
		bridge.paired_origins = Object.keys(context.security.getPairings());
	}
	return {
		...status,
		bridge,
		asr: context.codex.asrStatus ? context.codex.asrStatus() : {},
		jobs: context.jobManager.snapshot(),
	};
}

function errorStatusForResult(result) {
	if (result && result.category === 'validation') {
		return 400;
	}
	if (result && result.category === 'configuration') {
		return 503;
	}
	return 500;
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
		const status = statusPayload(context);
		sendJson(res, status.success ? 200 : 503, status, origin || pairedOriginForCors(req, bridgeSecurity));
		return;
	}

	if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
		sendJson(res, 200, capabilitiesPayload(context), origin || pairedOriginForCors(req, bridgeSecurity));
		return;
	}

	if (req.method === 'GET' && url.pathname === '/v1/asr/settings') {
		const payload = context.codex.asrSettings ? context.codex.asrSettings({ refresh: url.searchParams.get('refresh') === '1' }) : { success: false, message: 'ASR settings are unavailable.' };
		sendJson(res, payload.success === false ? 500 : 200, payload, origin || pairedOriginForCors(req, bridgeSecurity));
		return;
	}

	if (req.method === 'GET' && url.pathname === '/v1/status/events') {
		context.statusEvents.add(res, {
			events: ['status', 'capabilities', 'jobs'],
			initialEvents: [
				['status', statusPayload(context)],
				['capabilities', capabilitiesPayload(context)],
				['jobs', jobManager.snapshot()],
			],
		});
		return;
	}

	if (req.method === 'GET' && url.pathname === '/v1/status/stream') {
		const pairedOrigin = requirePairing(req, res, bridgeSecurity);
		if (!pairedOrigin) {
			return;
		}
		context.statusEvents.add(res, {
			origin: pairedOrigin,
			events: ['status', 'capabilities', 'jobs'],
			initialEvents: [
				['status', statusPayload(context, { includePairedOrigins: false })],
				['capabilities', capabilitiesPayload(context)],
				['jobs', jobManager.snapshot()],
			],
		});
		return;
	}

	if (req.method === 'GET' && url.pathname === '/v1/models') {
		const pairedOrigin = requirePairing(req, res, bridgeSecurity);
		if (!pairedOrigin) {
			return;
		}
		const modelPayload = codexAdapter.models();
		const videoCapabilities = context.video.capabilities ? context.video.capabilities() : { enabled: false, models: [] };
		if (modelPayload && modelPayload.models && videoCapabilities.enabled) {
			modelPayload.models.video = (videoCapabilities.models || []).map((id) => `openai-video:${id}`);
		}
		sendJson(res, 200, modelPayload, pairedOrigin);
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
		safeProcessSend({ type: 'pairing-code', pairingCode }, { logName: 'server' });
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

	if (url.pathname === '/v1/asr/settings') {
		if (!context.codex.saveAsrSettings || !context.codex.asrSettings) {
			sendErrorJson(req, res, 500, { success: false, message: 'ASR settings are unavailable.' }, origin);
			return;
		}
		const settings = context.codex.saveAsrSettings(body.settings || body || {});
		const payload = context.codex.asrSettings();
		context.statusEvents.broadcast('status', statusPayload(context));
		context.statusEvents.broadcast('capabilities', capabilitiesPayload(context));
		sendJson(res, 200, { success: true, settings, capabilities: payload.capabilities }, origin);
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
	if (url.pathname === '/v1/transcribe') {
		const result = await jobManager.run({
			requestId: body.request_id,
			type: 'transcribe',
			model: modelFromPayload(body.payload, 'codex-local:audio'),
		}, (session) => codexAdapter.transcribe(body.payload || {}, session));
		if (!result.success) {
			sendErrorJson(req, res, errorStatusForResult(result), result, pairedOrigin, { requestId: body.request_id, route: '/v1/transcribe' });
			return;
		}
		sendJson(res, 200, result, pairedOrigin);
		return;
	}
	if (url.pathname === '/v1/videos') {
		const result = await jobManager.run({
			requestId: body.request_id,
			type: 'videos',
			model: modelFromPayload(body.payload, 'sora-2'),
		}, (session) => context.video.run(body.payload || {}, session));
		if (!result.success) {
			sendErrorJson(req, res, errorStatusForResult(result), result, pairedOrigin, { requestId: body.request_id, route: '/v1/videos' });
			return;
		}
		sendJson(res, 200, result, pairedOrigin);
		return;
	}
	if (url.pathname === '/v1/media/analyze') {
		const result = await jobManager.run({
			requestId: body.request_id,
			type: 'media_analysis',
			model: modelFromPayload(body.payload, 'codex-local:auto'),
		}, (session) => context.mediaAnalysis.analyze(body.payload || {}, codexAdapter, session));
		if (!result.success) {
			sendErrorJson(req, res, errorStatusForResult(result), result, pairedOrigin, { requestId: body.request_id, route: '/v1/media/analyze' });
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
		mediaAnalysis: options.mediaAnalysis || mediaAnalysis,
		security: options.security || security,
		video: options.video || video,
		jobManager: options.jobManager || createJobManager({ ...options, onJobState }),
		statusEvents,
	};
	const server = http.createServer((req, res) => {
		route(req, res, context).catch((error) => {
			appendLog('server', 'Unhandled route failure.', {
				error: safeError(error),
				url: req.url,
				method: req.method,
			});
			try {
				if (!res.headersSent && !res.destroyed && !res.writableEnded) {
					sendErrorJson(req, res, 500, { success: false, message: error && error.message ? error.message : 'Unexpected bridge failure.' }, exposeOrigin(req, context.security));
				}
			} catch (sendError) {
				appendLog('server', 'Failed to send route error response.', { error: safeError(sendError) });
			}
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
		safeProcessSend({ type: 'ready', port: result.port, pairingCode }, { logName: 'server' });
		process.stdout.write(`Codex Local Bridge listening on http://127.0.0.1:${result.port}\n`);
		process.stdout.write(`Pairing code: ${pairingCode}\n`);
	}).catch((error) => {
		appendLog('server', 'Server failed to start.', { error: safeError(error) });
		safeProcessSend({ type: 'error', message: error && error.message ? error.message : String(error) }, { logName: 'server' });
		process.stderr.write((error && error.message ? error.message : String(error)) + '\n');
		process.exit(1);
	});
}

module.exports = {
	createServer,
	createStatusEvents,
	createJobManager,
	getPairingCode: () => pairingCode,
	startServer,
};
