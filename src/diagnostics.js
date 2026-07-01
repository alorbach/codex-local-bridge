'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;
const DEFAULT_MAX_OUTPUT_CHARS = 1024 * 1024;
const stateDir = path.join(os.homedir(), '.alorbach-codex-bridge');
const logDir = path.join(stateDir, 'logs');

function ensureLogDir() {
	fs.mkdirSync(logDir, { recursive: true });
}

function rotateIfNeeded(filePath, maxBytes = DEFAULT_MAX_LOG_BYTES) {
	try {
		const stat = fs.statSync(filePath);
		if (stat.size < maxBytes) {
			return;
		}
		const rotatedPath = `${filePath}.1`;
		try {
			fs.unlinkSync(rotatedPath);
		} catch (error) {}
		fs.renameSync(filePath, rotatedPath);
	} catch (error) {}
}

function appendLog(name, message, details = {}) {
	try {
		ensureLogDir();
		const safeName = String(name || 'bridge').replace(/[^a-z0-9_.-]/gi, '_');
		const filePath = path.join(logDir, `${safeName}.log`);
		rotateIfNeeded(filePath);
		const payload = {
			time: new Date().toISOString(),
			message: String(message || ''),
			...details,
		};
		fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
		return filePath;
	} catch (error) {
		return '';
	}
}

function safeError(error) {
	if (!error) {
		return {};
	}
	return {
		name: error.name || 'Error',
		message: error.message || String(error),
		code: error.code || undefined,
		stack: error.stack || undefined,
	};
}

function createBoundedCollector(options = {}) {
	const maxChars = Math.max(1024, Number(options.maxChars || DEFAULT_MAX_OUTPUT_CHARS) || DEFAULT_MAX_OUTPUT_CHARS);
	const requestedHeadChars = Math.floor(Number(options.headChars || Math.floor(maxChars / 2)) || Math.floor(maxChars / 2));
	const headChars = Math.max(1, Math.min(maxChars - 1, requestedHeadChars));
	const tailChars = Math.max(1, maxChars - headChars);
	let buffered = '';
	let head = '';
	let tail = '';
	let totalChars = 0;
	let truncated = false;

	function trimTail(value) {
		return value.length > tailChars ? value.slice(-tailChars) : value;
	}

	return {
		append(chunk) {
			const text = String(chunk || '');
			if (!text) {
				return;
			}
			totalChars += text.length;
			if (!truncated && totalChars <= maxChars) {
				buffered += text;
				return;
			}
			if (!truncated) {
				const combined = buffered + text;
				head = combined.slice(0, headChars);
				tail = combined.slice(-tailChars);
				buffered = '';
				truncated = true;
				return;
			}
			tail = trimTail(tail + text);
		},
		value() {
			if (!truncated) {
				return buffered;
			}
			const omitted = Math.max(0, totalChars - head.length - tail.length);
			return `${head}\n\n...[truncated ${omitted} chars]...\n\n${tail}`;
		},
		stats() {
			return {
				total_chars: totalChars,
				truncated_chars: truncated ? Math.max(0, totalChars - head.length - tail.length) : 0,
				retained_chars: truncated ? head.length + tail.length : buffered.length,
			};
		},
	};
}

function safeProcessSend(message, options = {}) {
	if (!process.send) {
		return false;
	}
	try {
		process.send(message);
		return true;
	} catch (error) {
		if (error && (error.code === 'ERR_IPC_CHANNEL_CLOSED' || error.code === 'EPIPE')) {
			appendLog(options.logName || 'server', 'IPC send ignored after parent disconnect.', {
				error: safeError(error),
				ipc_message_type: message && message.type || '',
			});
			return false;
		}
		appendLog(options.logName || 'server', 'IPC send failed.', {
			error: safeError(error),
			ipc_message_type: message && message.type || '',
		});
		return false;
	}
}

module.exports = {
	appendLog,
	createBoundedCollector,
	logDir,
	safeError,
	safeProcessSend,
	stateDir,
};
