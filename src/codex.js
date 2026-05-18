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
	const { timeout, ...spawnOptions } = options;
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

		const timer = timeout ? setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeout) : null;

		if (timer && typeof timer.unref === 'function') {
			timer.unref();
		}
		child.stdout.on('data', (chunk) => {
			stdout += String(chunk || '');
		});
		child.stderr.on('data', (chunk) => {
			stderr += String(chunk || '');
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

function parseUsage(stdout, stderr) {
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

function messagesToPrompt(messages, maxTokens) {
	const parts = [
		'Respond to the following WordPress Gateway chat transcript.',
		'Do not access local files, run shell commands, or modify the filesystem.',
		`Maximum response tokens hint: ${maxTokens || 1024}.`,
		'',
	];
	for (const message of Array.isArray(messages) ? messages : []) {
		const role = String(message.role || 'user');
		const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '');
		parts.push(`${role.toUpperCase()}: ${content}`);
	}
	parts.push('', 'ASSISTANT:');
	return parts.join('\n');
}

async function chat(payload) {
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
	const prompt = messagesToPrompt(messages, payload.max_tokens);
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
	args.push(prompt);
	const run = await runCodexAsync(args, { cwd: tempDir, timeout: Number(process.env.ALORBACH_CODEX_CHAT_TIMEOUT_MS || 600000) });
	const stdout = (run.stdout || '').trim();
	const stderr = (run.stderr || '').trim();
	let responseText = '';
	if (fs.existsSync(outputFile)) {
		responseText = fs.readFileSync(outputFile, 'utf8').trim();
	}
	if (run.error) {
		return { success: false, message: 'Codex CLI could not be executed for chat.', details: { error: run.error.message || String(run.error) } };
	}
	if (run.status !== 0) {
		return { success: false, message: 'Codex CLI chat request failed.', details: { stdout, stderr, response_text: responseText } };
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
			usage: parseUsage(stdout, stderr),
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

async function images(payload) {
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
		imagePrompt(payload),
	];
	const run = await runCodexAsync(args, { cwd: tempDir, timeout: Number(process.env.ALORBACH_CODEX_IMAGE_TIMEOUT_MS || 1800000) });
	const after = listGeneratedImages(generatedImagesDir);
	const newImages = detectNewImage(before, after);
	const stdout = (run.stdout || '').trim();
	const stderr = (run.stderr || '').trim();
	if (run.error) {
		return { success: false, message: 'Codex CLI could not be executed for image generation.', details: { error: run.error.message || String(run.error) } };
	}
	if (run.status !== 0) {
		return { success: false, message: 'Codex CLI image generation failed.', details: { stdout, stderr } };
	}
	if (!newImages.length) {
		return { success: false, message: 'Codex CLI completed, but no new generated image file was detected.', details: { generated_images_dir: generatedImagesDir, stdout, stderr } };
	}
	const bytes = fs.readFileSync(newImages[0].path);
	return {
		success: true,
		response: {
			data: [{ b64_json: bytes.toString('base64') }],
			usage: parseUsage(stdout, stderr),
			provider_details: { image_path: newImages[0].path, generated_images_dir: generatedImagesDir },
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

module.exports = {
	checkStatus,
	chat,
	images,
	models,
	runCodexAsync,
	resolveCodexBinary,
};
