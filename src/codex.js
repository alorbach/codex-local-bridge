'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const codexBinary = process.env.ALORBACH_CODEX_BINARY || 'codex';
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const authPath = path.join(codexHome, 'auth.json');
const generatedImagesDir = path.join(codexHome, 'generated_images');

function collectCodexExe(root, matches, depth = 0) {
	if (!root || depth > 6 || !fs.existsSync(root)) {
		return;
	}
	let entries = [];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch (error) {
		return;
	}
	for (const entry of entries) {
		const fullPath = path.join(root, entry.name);
		if (entry.isFile() && entry.name.toLowerCase() === 'codex.exe') {
			matches.push(fullPath);
			continue;
		}
		if (!entry.isDirectory()) {
			continue;
		}
		const name = entry.name.toLowerCase();
		if (depth === 0 && name.indexOf('openai.chatgpt-') !== 0 && root.toLowerCase().indexOf('programs') === -1) {
			continue;
		}
		collectCodexExe(fullPath, matches, depth + 1);
	}
}

function findWindowsCodexExtensionBinary() {
	const home = os.homedir();
	const roots = [
		path.join(home, '.vscode', 'extensions'),
		path.join(home, '.cursor', 'extensions'),
		path.join(process.env.LOCALAPPDATA || '', 'Programs'),
	].filter(Boolean);
	const matches = [];
	for (const root of roots) {
		collectCodexExe(root, matches);
	}
	matches.sort((a, b) => b.localeCompare(a));
	return matches[0] || '';
}

function resolveCodexBinary() {
	if (process.platform !== 'win32' || /[\\/]/.test(codexBinary)) {
		return codexBinary;
	}
	const extensionBinary = findWindowsCodexExtensionBinary();
	if (extensionBinary) {
		return extensionBinary;
	}
	const lookup = spawnSync('where.exe', [codexBinary], { encoding: 'utf8', shell: false });
	if (lookup.status === 0) {
		const matches = (lookup.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		return matches.find((line) => /\.exe$/i.test(line)) || matches.find((line) => /\.(cmd|bat)$/i.test(line)) || matches[0] || codexBinary;
	}
	return codexBinary;
}

function runCodex(args, options = {}) {
	return spawnSync(resolveCodexBinary(), args, {
		encoding: 'utf8',
		shell: false,
		env: {
			...process.env,
			CODEX_HOME: codexHome,
		},
		...options,
	});
}

function runCodexAsync(args, options = {}) {
	const { timeout, onOutput, input, ...spawnOptions } = options;
	const emitOutput = typeof onOutput === 'function' ? onOutput : () => {};
	const stdinInput = typeof input === 'string' || Buffer.isBuffer(input) ? input : null;
	return new Promise((resolve) => {
		let child;
		let stdout = '';
		let stderr = '';
		let spawnError = null;
		let timedOut = false;
		try {
			child = spawn(resolveCodexBinary(), args, {
				shell: false,
				windowsHide: true,
				stdio: [stdinInput === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
				env: {
					...process.env,
					CODEX_HOME: codexHome,
				},
				...spawnOptions,
			});
		} catch (error) {
			resolve({ stdout, stderr, status: null, signal: null, error });
			return;
		}
		if (stdinInput !== null && child.stdin) {
			child.stdin.once('error', (error) => {
				spawnError = spawnError || error;
			});
			child.stdin.end(stdinInput);
		}

		const timer = timeout ? setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeout) : null;

		if (timer && typeof timer.unref === 'function') {
			timer.unref();
		}
		child.stdout.on('data', (chunk) => {
			const text = String(chunk || '');
			stdout += text;
			emitOutput('stdout', text);
		});
		child.stderr.on('data', (chunk) => {
			const text = String(chunk || '');
			stderr += text;
			emitOutput('stderr', text);
		});
		child.once('error', (error) => {
			spawnError = error;
		});
		child.once('close', (status, signal) => {
			if (timer) {
				clearTimeout(timer);
			}
			resolve({
				stdout,
				stderr,
				status,
				signal,
				error: spawnError || (timedOut ? new Error('Codex CLI execution timed out.') : null),
			});
		});
	});
}

function checkStatus() {
	const version = runCodex(['--version']);
	if (version.error) {
		return {
			success: false,
			message: 'Codex CLI is not installed or not on PATH.',
			details: { codex_binary: resolveCodexBinary(), error: version.error.message || String(version.error) },
		};
	}
	if (version.status !== 0) {
		return {
			success: false,
			message: 'Codex CLI was found, but `codex --version` failed.',
			details: { codex_binary: resolveCodexBinary(), stderr: (version.stderr || '').trim() },
		};
	}
	const login = runCodex(['login', 'status']);
	const loginText = `${login.stdout || ''}\n${login.stderr || ''}`;
	const loggedIn = !login.error && login.status === 0 && /logged in/i.test(loginText) && fs.existsSync(authPath);
	return {
		success: loggedIn,
		message: loggedIn ? 'Local Codex CLI is installed and logged in.' : 'Codex CLI is installed, but this user is not logged in.',
		details: {
			codex_binary: resolveCodexBinary(),
			codex_home: codexHome,
			auth_path: authPath,
			generated_images_dir: generatedImagesDir,
			version: (version.stdout || version.stderr || '').trim(),
			login_status: (login.stdout || login.stderr || '').trim(),
		},
	};
}

function normalizeTokenCount(rawValue) {
	const digits = String(rawValue || '').replace(/[^\d]/g, '');
	return digits ? Number.parseInt(digits, 10) || 0 : 0;
}

function parseUsage(stdout, stderr, structured) {
	if (structured && structured.usage) {
		return structured.usage;
	}
	const combined = `${stdout || ''}\n${stderr || ''}`;
	const patterns = [
		/tokens used\s*[:\-]?\s*([\d,]+)/i,
		/tokens used[\s\S]{0,80}?([\d,]+)/i,
	];
	for (const pattern of patterns) {
		const match = combined.match(pattern);
		if (match && match[1]) {
			const total = normalizeTokenCount(match[1]);
			if (total > 0) {
				return { total_tokens: total };
			}
		}
	}
	return { total_tokens: 0, local_unmetered: true };
}

function textFromUnknown(value) {
	if (typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(textFromUnknown).filter(Boolean).join('\n');
	}
	if (!value || typeof value !== 'object') {
		return '';
	}
	for (const key of ['text', 'content', 'message', 'output', 'result']) {
		const text = textFromUnknown(value[key]);
		if (text) {
			return text;
		}
	}
	return '';
}

function eventUsage(event) {
	if (!event || typeof event !== 'object') {
		return null;
	}
	const usage = event.usage || (event.turn && event.turn.usage) || (event.payload && event.payload.usage);
	if (!usage || typeof usage !== 'object') {
		return null;
	}
	const total = normalizeTokenCount(usage.total_tokens || usage.total || usage.tokens_used);
	if (total > 0) {
		return { total_tokens: total };
	}
	return null;
}

function codexEventError(event) {
	if (!event || typeof event !== 'object') {
		return '';
	}
	const error = event.error || (event.payload && event.payload.error);
	if (typeof error === 'string') {
		return error;
	}
	if (error && typeof error === 'object') {
		return String(error.message || error.code || JSON.stringify(error));
	}
	if (/failed|error/i.test(String(event.type || event.event || ''))) {
		return textFromUnknown(event) || String(event.type || event.event || 'Codex event failed.');
	}
	return '';
}

function summarizeCodexEvent(event) {
	const type = String((event && (event.type || event.event)) || '').trim();
	if (!type) {
		return '';
	}
	const item = event.item || (event.payload && event.payload.item) || {};
	const itemType = String(item.type || item.kind || '').trim();
	const error = codexEventError(event);
	if (error) {
		return `${type}: ${error}`;
	}
	if (/message|agent/i.test(itemType)) {
		const text = textFromUnknown(item);
		return text ? `${type}/${itemType}: ${text.slice(0, 500)}` : `${type}/${itemType}`;
	}
	if (/command|exec|shell/i.test(itemType)) {
		const command = textFromUnknown(item.command || item.args || item);
		return command ? `${type}/${itemType}: ${command.slice(0, 500)}` : `${type}/${itemType}`;
	}
	if (/thread|turn/.test(type)) {
		return type;
	}
	return '';
}

function parseCodexJsonEvents(stdout) {
	const events = [];
	const errors = [];
	const finalMessages = [];
	const invalidLines = [];
	let usage = null;
	for (const line of String(stdout || '').split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		let event;
		try {
			event = JSON.parse(trimmed);
		} catch (error) {
			invalidLines.push(trimmed.slice(0, 1000));
			continue;
		}
		events.push(event);
		const errorText = codexEventError(event);
		if (errorText) {
			errors.push(errorText);
		}
		const eventType = String(event.type || event.event || '');
		const item = event.item || (event.payload && event.payload.item) || {};
		const itemType = String(item.type || item.kind || '');
		if (/completed|message|item/.test(eventType) && /message|agent/i.test(itemType)) {
			const text = textFromUnknown(item);
			if (text) {
				finalMessages.push(text);
			}
		}
		const nextUsage = eventUsage(event);
		if (nextUsage) {
			usage = nextUsage;
		}
	}
	return {
		events,
		errors,
		finalMessages,
		invalidLines,
		summary: events.map(summarizeCodexEvent).filter(Boolean).slice(-40),
		usage,
	};
}

function codexJsonUnsupported(run) {
	const combined = `${run && run.stdout || ''}\n${run && run.stderr || ''}`;
	return !!(run && run.status !== 0 && /(?:unknown|unexpected|unrecognized).{0,80}(?:--json|json)|(?:--json|json).{0,80}(?:unknown|unexpected|unrecognized)/i.test(combined));
}

function createJsonOutputCollector(onOutput) {
	let pending = '';
	const parsedLines = [];
	const emit = typeof onOutput === 'function' ? onOutput : () => {};
	function consume(line) {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		parsedLines.push(trimmed);
		try {
			const event = JSON.parse(trimmed);
			const summary = summarizeCodexEvent(event);
			if (summary) {
				emit('event', summary);
			}
		} catch (error) {}
	}
	return {
		append(chunk) {
			pending += String(chunk || '');
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() || '';
			for (const line of lines) {
				consume(line);
			}
		},
		flush() {
			if (pending) {
				consume(pending);
				pending = '';
			}
		},
		raw() {
			return parsedLines.join('\n');
		},
	};
}

async function runCodexExec(args, options = {}) {
	const jsonArgs = args[0] === 'exec' ? ['exec', '--json', ...args.slice(1)] : ['--json', ...args];
	const onOutput = typeof options.onOutput === 'function' ? options.onOutput : () => {};
	const collector = createJsonOutputCollector(onOutput);
	const run = await runCodexAsync(jsonArgs, {
		...options,
		onOutput: (stream, chunk) => {
			if (stream === 'stdout') {
				collector.append(chunk);
				return;
			}
			onOutput(stream, chunk);
		},
	});
	collector.flush();
	run.structured = parseCodexJsonEvents(run.stdout || collector.raw());
	run.used_json = true;
	if (!codexJsonUnsupported(run)) {
		return run;
	}
	const fallback = await runCodexAsync(args, options);
	fallback.structured = parseCodexJsonEvents('');
	fallback.used_json = false;
	fallback.json_fallback_reason = 'Codex CLI does not support `codex exec --json`.';
	return fallback;
}

function codexImageFailureFromOutput(stdout, stderr, generatedImagesPath = generatedImagesDir, structured = null) {
	const cleanStdout = String(stdout || '').trim();
	const cleanStderr = String(stderr || '').trim();
	const combined = `${cleanStdout}\n${cleanStderr}`;
	const details = { generated_images_dir: generatedImagesPath, stdout: cleanStdout, stderr: cleanStderr };
	if (structured && structured.summary && structured.summary.length) {
		details.structured_events = structured.summary;
	}
	if (structured && structured.errors && structured.errors.length) {
		details.event_errors = structured.errors;
	}
	if (/rate limit|rate-limit|rate limiting|too many requests/i.test(combined)) {
		return {
			success: false,
			code: 'codex_rate_limited',
			category: 'rate_limit',
			retryable: true,
			message: 'Codex image generation was rate limited. Please wait and retry.',
			details,
		};
	}
	return {
		success: false,
		code: 'codex_no_image_output',
		category: 'output_detection',
		retryable: false,
		message: 'Codex CLI completed, but no new generated image file was detected.',
		details,
	};
}

function imageExtensionForMime(mime) {
	const normalized = String(mime || '').toLowerCase();
	if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
		return 'jpg';
	}
	if (normalized === 'image/png') {
		return 'png';
	}
	if (normalized === 'image/webp') {
		return 'webp';
	}
	if (normalized === 'image/gif') {
		return 'gif';
	}
	return 'bin';
}

function tryWriteDataImage(value, tempDir, index) {
	if (!tempDir) {
		return null;
	}
	const text = String(value || '').trim();
	const match = text.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
	if (!match) {
		return null;
	}
	const mime = match[1].toLowerCase();
	const extension = imageExtensionForMime(mime);
	if (extension === 'bin') {
		return null;
	}
	const base64 = match[2].replace(/\s+/g, '');
	const bytes = Buffer.from(base64, 'base64');
	if (!bytes.length) {
		return null;
	}
	const imagePath = path.join(tempDir, `input-image-${index}.${extension}`);
	fs.writeFileSync(imagePath, bytes);
	return {
		bytes: bytes.length,
		mime,
		path: imagePath,
	};
}

function safeStringifyForPrompt(value) {
	return JSON.stringify(value, (key, item) => {
		if (typeof item === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(item)) {
			return `[data image omitted from text prompt, ${item.length} chars]`;
		}
		return item;
	});
}

function imageValueFromPart(part) {
	if (!part || typeof part !== 'object') {
		return '';
	}
	if (typeof part.image_url === 'string') {
		return part.image_url;
	}
	if (part.image_url && typeof part.image_url === 'object' && typeof part.image_url.url === 'string') {
		return part.image_url.url;
	}
	if (typeof part.url === 'string') {
		return part.url;
	}
	return '';
}

function contentPartsToPrompt(content, tempDir, attachments) {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return safeStringifyForPrompt(content || '');
	}
	const lines = [];
	for (const part of content) {
		if (typeof part === 'string') {
			lines.push(part);
			continue;
		}
		if (!part || typeof part !== 'object') {
			continue;
		}
		const type = String(part.type || '').toLowerCase();
		if (type === 'input_text' || type === 'text') {
			lines.push(String(part.text || part.content || ''));
			continue;
		}
		if (type === 'input_image' || type === 'image_url') {
			const imageValue = imageValueFromPart(part);
			const attachment = tryWriteDataImage(imageValue, tempDir, attachments.length + 1);
			if (attachment) {
				attachments.push(attachment);
				lines.push(`[Attached image ${attachments.length}: ${attachment.mime}, ${attachment.bytes} bytes, passed to Codex as an image attachment.]`);
			} else if (imageValue && /^data:image\/[a-z0-9.+-]+;base64,/i.test(imageValue)) {
				lines.push('[Image attachment could not be decoded and was omitted from the text prompt.]');
			} else if (imageValue) {
				lines.push(`[Image URL attachment: ${imageValue.slice(0, 512)}]`);
			} else {
				lines.push('[Image attachment without readable image data.]');
			}
			continue;
		}
		lines.push(safeStringifyForPrompt(part));
	}
	return lines.filter(Boolean).join('\n');
}

function buildChatPrompt(messages, maxTokens, tempDir) {
	const attachments = [];
	const parts = [
		'Respond to the following WordPress Gateway chat transcript.',
		'Do not access local files, run shell commands, or modify the filesystem.',
		`Maximum response tokens hint: ${maxTokens || 1024}.`,
		'',
	];
	for (const message of Array.isArray(messages) ? messages : []) {
		const role = String(message.role || 'user');
		const content = contentPartsToPrompt(message.content, tempDir, attachments);
		parts.push(`${role.toUpperCase()}: ${content}`);
	}
	parts.push('', 'ASSISTANT:');
	return {
		attachments,
		prompt: parts.join('\n'),
	};
}

function messagesToPrompt(messages, maxTokens) {
	return buildChatPrompt(messages, maxTokens, '').prompt;
}

async function chat(payload, session = {}) {
	const status = checkStatus();
	if (!status.success) {
		return status;
	}
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	if (!messages.length) {
		return { success: false, message: 'No chat messages were provided.' };
	}
	const model = String(payload.model || 'codex-local:auto').replace(/^codex-local:/, '') || 'auto';
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alorbach-codex-chat-'));
	const outputFile = path.join(tempDir, 'last-message.txt');
	const { attachments, prompt } = buildChatPrompt(messages, payload.max_tokens, tempDir);
	const args = [
		'exec',
		'--skip-git-repo-check',
		'--ephemeral',
		'--cd',
		tempDir,
		'--output-last-message',
		outputFile,
	];
	if (model !== 'auto') {
		args.push('--model', model);
	}
	for (const attachment of attachments) {
		args.push('--image', attachment.path);
	}
	args.push('-');
	const run = await runCodexExec(args, { cwd: tempDir, timeout: Number(process.env.ALORBACH_CODEX_CHAT_TIMEOUT_MS || 600000), onOutput: session.appendSessionOutput, input: prompt });
	const stdout = (run.stdout || '').trim();
	const stderr = (run.stderr || '').trim();
	let responseText = '';
	if (fs.existsSync(outputFile)) {
		responseText = fs.readFileSync(outputFile, 'utf8').trim();
	}
	if (!responseText && run.structured && run.structured.finalMessages.length) {
		responseText = run.structured.finalMessages[run.structured.finalMessages.length - 1].trim();
	}
	if (run.error) {
		return { success: false, message: 'Codex CLI could not be executed for chat.', details: { error: run.error.message || String(run.error), stdout, stderr, status: run.status, signal: run.signal, structured_events: run.structured && run.structured.summary, event_errors: run.structured && run.structured.errors } };
	}
	if (run.status !== 0) {
		return { success: false, message: 'Codex CLI chat request failed.', details: { stdout, stderr, response_text: responseText, structured_events: run.structured && run.structured.summary, event_errors: run.structured && run.structured.errors } };
	}
	return {
		success: true,
		response: {
			id: `local-codex-${Date.now()}`,
			object: 'chat.completion',
			model: `codex-local:${model}`,
			choices: [
				{
					index: 0,
					message: { role: 'assistant', content: responseText || stdout },
					finish_reason: 'stop',
				},
			],
			usage: parseUsage(stdout, stderr, run.structured),
			provider_details: {
				structured_events: !!run.used_json,
				json_fallback_reason: run.json_fallback_reason || undefined,
			},
		},
	};
}

function listGeneratedImages(dir) {
	const results = [];
	if (!fs.existsSync(dir)) {
		return results;
	}
	const stack = [dir];
	while (stack.length) {
		const current = stack.pop();
		let entries = [];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch (error) {
			continue;
		}
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
			} else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) {
				const stat = fs.statSync(fullPath);
				results.push({ path: fullPath, mtimeMs: stat.mtimeMs });
			}
		}
	}
	return results;
}

function detectNewImage(before, after) {
	const known = new Set(before.map((item) => item.path.toLowerCase()));
	return after.filter((item) => !known.has(item.path.toLowerCase())).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function imagePrompt(payload) {
	const prompt = String(payload.prompt || '').trim();
	const size = String(payload.size || '1024x1024').trim();
	const quality = String(payload.quality || 'high').trim();
	return [
		'Generate exactly one image using your built-in image generation tool.',
		'Do not access unrelated local files or modify anything except generated image output.',
		`User prompt: ${prompt}`,
		`Requested size: ${size}`,
		`Preferred quality: ${quality}`,
		'After the image has been generated, reply with a short plain-text confirmation only.',
	].join('\n');
}

async function images(payload, session = {}) {
	const status = checkStatus();
	if (!status.success) {
		return status;
	}
	const prompt = String(payload.prompt || '').trim();
	if (!prompt) {
		return { success: false, message: 'No image prompt was provided.' };
	}
	fs.mkdirSync(generatedImagesDir, { recursive: true });
	const before = listGeneratedImages(generatedImagesDir);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alorbach-codex-image-'));
	const outputFile = path.join(tempDir, 'last-message.txt');
	const args = [
		'exec',
		'--skip-git-repo-check',
		'--ephemeral',
		'--cd',
		tempDir,
		'--output-last-message',
		outputFile,
		'-',
	];
	const run = await runCodexExec(args, { cwd: tempDir, timeout: Number(process.env.ALORBACH_CODEX_IMAGE_TIMEOUT_MS || 1800000), onOutput: session.appendSessionOutput, input: imagePrompt(payload) });
	const after = listGeneratedImages(generatedImagesDir);
	const newImages = detectNewImage(before, after);
	const stdout = (run.stdout || '').trim();
	const stderr = (run.stderr || '').trim();
	if (run.error) {
		return { success: false, message: 'Codex CLI could not be executed for image generation.', details: { error: run.error.message || String(run.error), stdout, stderr, status: run.status, signal: run.signal, structured_events: run.structured && run.structured.summary, event_errors: run.structured && run.structured.errors } };
	}
	if (run.status !== 0) {
		const failure = codexImageFailureFromOutput(stdout, stderr, generatedImagesDir, run.structured);
		if (failure.code === 'codex_rate_limited') {
			return failure;
		}
		return { success: false, code: 'codex_cli_image_failed', category: 'codex_cli', message: 'Codex CLI image generation failed.', details: { stdout, stderr, structured_events: run.structured && run.structured.summary, event_errors: run.structured && run.structured.errors } };
	}
	if (!newImages.length) {
		return codexImageFailureFromOutput(stdout, stderr, generatedImagesDir, run.structured);
	}
	const bytes = fs.readFileSync(newImages[0].path);
	return {
		success: true,
		response: {
			data: [{ b64_json: bytes.toString('base64') }],
			usage: parseUsage(stdout, stderr, run.structured),
			provider_details: { image_path: newImages[0].path, generated_images_dir: generatedImagesDir, structured_events: !!run.used_json, json_fallback_reason: run.json_fallback_reason || undefined },
		},
	};
}

function models() {
	const cachePath = path.join(codexHome, 'models_cache.json');
	const text = ['auto'];
	try {
		const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
		const items = Array.isArray(raw) ? raw : (Array.isArray(raw.models) ? raw.models : []);
		for (const item of items) {
			const id = String(item.id || item.slug || '').trim();
			if (id && !text.includes(id)) {
				text.push(id);
			}
		}
	} catch (error) {}
	return {
		success: true,
		models: {
			text: text.map((id) => `codex-local:${id}`),
			image: ['codex-local:image'],
		},
	};
}

function capabilities() {
	const version = runCodex(['--version']);
	const help = runCodex(['exec', '--help']);
	const appServer = runCodex(['app-server', '--help']);
	const helpText = `${help.stdout || ''}\n${help.stderr || ''}`;
	return {
		success: !version.error && version.status === 0,
		bridge_features: {
			chat: true,
			images: true,
			media_analysis: true,
			structured_exec_json: /--json/.test(helpText),
			output_schema: /--output-schema/.test(helpText),
			image_attachments: /--image/.test(helpText),
			app_server: !appServer.error && appServer.status === 0,
		},
		codex: {
			binary: resolveCodexBinary(),
			version: (version.stdout || version.stderr || '').trim(),
			exec_help_available: !help.error && help.status === 0,
			app_server_available: !appServer.error && appServer.status === 0,
		},
	};
}

module.exports = {
	buildChatPrompt,
	capabilities,
	checkStatus,
	chat,
	codexImageFailureFromOutput,
	codexJsonUnsupported,
	images,
	messagesToPrompt,
	models,
	parseCodexJsonEvents,
	runCodexAsync,
	runCodexExec,
	resolveCodexBinary,
};
