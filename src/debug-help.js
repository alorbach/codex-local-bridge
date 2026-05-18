'use strict';

function requestBaseUrl(req) {
	const host = String(req && req.headers && req.headers.host ? req.headers.host : '127.0.0.1:8765').trim();
	return `http://${host || '127.0.0.1:8765'}`;
}

function buildDebugHelp(req, options = {}) {
	const baseUrl = requestBaseUrl(req);
	const requestId = String(options.requestId || '').trim();
	const route = String(options.route || (req && req.url) || '').trim();
	const statusCode = Number(options.statusCode || 0) || undefined;
	return {
		request_id: requestId || undefined,
		route: route || undefined,
		status_code: statusCode,
		status_page: `${baseUrl}/status`,
		status_json: `${baseUrl}/v1/status`,
		checks: [
			'Open the status page and check Codex readiness plus recent failed jobs.',
			'Use the tray menu Copy diagnostics action for a safe diagnostic payload without bearer tokens.',
			'Run codex login status in the same Windows account as the tray app.',
			'Confirm the browser origin is paired and the request includes the bridge token.',
			'If jobs are queued or running, wait for the active local Codex process to finish and retry.',
		],
	};
}

function attachDebugHelp(req, payload, options = {}) {
	return {
		...payload,
		debug_help: buildDebugHelp(req, {
			...options,
			requestId: options.requestId || payload.request_id,
			route: options.route,
			statusCode: options.statusCode,
		}),
	};
}

module.exports = {
	attachDebugHelp,
	buildDebugHelp,
};
