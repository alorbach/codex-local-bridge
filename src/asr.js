'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { appendLog, createBoundedCollector, safeError } = require('./diagnostics');
const security = require('./security');

const MODEL_PREFIX = 'codex-local:audio';
const RUNNER_PATH = path.join(__dirname, 'asr-runner.py');
const DEFAULT_TIMEOUT_MS = Number(process.env.ALORBACH_ASR_TRANSCRIBE_TIMEOUT_MS || 1800000);
const DEFAULT_PROBE_TTL_MS = Number(process.env.ALORBACH_ASR_PROBE_TTL_MS || 30000);
const DEFAULT_PYTHON310 = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe');
const DEFAULT_VENV_PATH = path.join(security.stateDir, 'asr-venv');
const MAX_AUDIO_BASE64_LENGTH = 67108864;
let probeCache = null;

const DEFAULT_MODELS = [
	{
		id: 'whisper-large-v3',
		label: 'Local Whisper Large v3',
		repo_id: 'ctranslate2-4you/whisper-large-v3-ct2-float32',
		gpu_repo_id: 'ctranslate2-4you/whisper-large-v3-ct2-float16',
		min_vram_mb: 8192,
		enabled: true,
		preferred_device: 'auto',
	},
	{
		id: 'whisper-medium',
		label: 'Local Whisper Medium',
		repo_id: 'Systran/faster-whisper-medium',
		min_vram_mb: 4096,
		enabled: true,
		preferred_device: 'auto',
	},
	{
		id: 'whisper-small',
		label: 'Local Whisper Small',
		repo_id: 'Systran/faster-whisper-small',
		min_vram_mb: 2048,
		enabled: true,
		preferred_device: 'auto',
	},
];

function readState() {
	try {
		const parsed = JSON.parse(fs.readFileSync(security.statePath, 'utf8'));
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch (error) {
		return {};
	}
}

function writeState(state) {
	fs.mkdirSync(security.stateDir, { recursive: true });
	fs.writeFileSync(security.statePath, JSON.stringify(state, null, 2));
}

function fullModelId(id) {
	const model = String(id || '').trim();
	if (!model || model === MODEL_PREFIX) {
		return MODEL_PREFIX;
	}
	if (model.indexOf(`${MODEL_PREFIX}:`) === 0) {
		return model;
	}
	return `${MODEL_PREFIX}:${model.replace(/^codex-local:/, '').replace(/^audio:/, '')}`;
}

function modelSlug(id) {
	const model = String(id || '').trim();
	if (!model || model === MODEL_PREFIX) {
		return '';
	}
	return model.replace(`${MODEL_PREFIX}:`, '').replace(/^codex-local:/, '').replace(/^audio:/, '');
}

function normalizeModelEntry(entry, fallback = {}) {
	const source = entry && typeof entry === 'object' ? entry : {};
	const id = modelSlug(source.id || fallback.id);
	return {
		id,
		label: String(source.label || fallback.label || id).trim() || id,
		repo_id: String(source.repo_id || fallback.repo_id || '').trim(),
		gpu_repo_id: String(source.gpu_repo_id || fallback.gpu_repo_id || '').trim(),
		local_path: String(source.local_path || fallback.local_path || '').trim(),
		min_vram_mb: Math.max(0, Number(source.min_vram_mb ?? fallback.min_vram_mb ?? 0) || 0),
		enabled: source.enabled !== false,
		preferred_device: ['auto', 'cpu', 'cuda'].includes(String(source.preferred_device || fallback.preferred_device || 'auto')) ? String(source.preferred_device || fallback.preferred_device || 'auto') : 'auto',
	};
}

function defaultSettings() {
	return {
		allow_package_install: true,
		allow_model_downloads: false,
		python_path: process.env.ALORBACH_ASR_PYTHON || '',
		venv_path: process.env.ALORBACH_ASR_VENV || DEFAULT_VENV_PATH,
		cpu_threads: Math.max(1, Number(process.env.ALORBACH_ASR_CPU_THREADS || 4) || 4),
		num_workers: 1,
		beam_size: 5,
		best_of: 5,
		vad_filter: false,
		condition_on_previous_text: true,
		models: DEFAULT_MODELS.map((entry) => normalizeModelEntry(entry)),
	};
}

function normalizeSettings(raw) {
	const defaults = defaultSettings();
	const source = raw && typeof raw === 'object' ? raw : {};
	const defaultById = new Map(defaults.models.map((entry) => [entry.id, entry]));
	const merged = {
		allow_package_install: source.allow_package_install !== false,
		allow_model_downloads: source.allow_model_downloads === true,
		python_path: String(source.python_path || defaults.python_path || '').trim(),
		venv_path: String(source.venv_path || defaults.venv_path || '').trim() || defaults.venv_path,
		cpu_threads: Math.max(1, Number(source.cpu_threads || defaults.cpu_threads) || defaults.cpu_threads),
		num_workers: Math.max(1, Number(source.num_workers || defaults.num_workers) || defaults.num_workers),
		beam_size: Math.max(1, Number(source.beam_size || defaults.beam_size) || defaults.beam_size),
		best_of: Math.max(1, Number(source.best_of || defaults.best_of) || defaults.best_of),
		vad_filter: source.vad_filter === true,
		condition_on_previous_text: source.condition_on_previous_text !== false,
		models: [],
	};
	const seen = new Set();
	for (const entry of Array.isArray(source.models) ? source.models : []) {
		const normalized = normalizeModelEntry(entry, defaultById.get(modelSlug(entry && entry.id)));
		if (normalized.id && !seen.has(normalized.id)) {
			merged.models.push(normalized);
			seen.add(normalized.id);
		}
	}
	for (const fallback of defaults.models) {
		if (!seen.has(fallback.id)) {
			merged.models.push(fallback);
		}
	}
	return merged;
}

function settings() {
	const state = readState();
	return normalizeSettings(state.asr || {});
}

function saveSettings(nextSettings) {
	const state = readState();
	state.asr = normalizeSettings(nextSettings);
	writeState(state);
	invalidateProbeCache();
	return state.asr;
}

function audioExtensionForFormat(format) {
	const normalized = String(format || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	if (['mp3', 'wav', 'm4a', 'mp4', 'ogg', 'opus', 'flac', 'webm'].includes(normalized)) {
		return normalized === 'opus' ? 'ogg' : normalized;
	}
	return 'audio';
}

function runSync(command, args = [], options = {}) {
	return spawnSync(command, args, {
		encoding: 'utf8',
		shell: false,
		windowsHide: true,
		...options,
	});
}

function executableWorks(command, argsPrefix = []) {
	if (!command) {
		return false;
	}
	const result = runSync(command, [...argsPrefix, '-c', 'import sys; print(sys.version)']);
	return !result.error && result.status === 0;
}

function pythonCandidates(config = settings()) {
	const candidates = [];
	if (config.python_path) {
		candidates.push({ command: config.python_path, argsPrefix: [], source: 'settings' });
	}
	if (process.env.ALORBACH_ASR_PYTHON && process.env.ALORBACH_ASR_PYTHON !== config.python_path) {
		candidates.push({ command: process.env.ALORBACH_ASR_PYTHON, argsPrefix: [], source: 'environment' });
	}
	candidates.push({ command: DEFAULT_PYTHON310, argsPrefix: [], source: 'python310' });
	candidates.push({ command: 'py.exe', argsPrefix: ['-3.10'], source: 'py -3.10' });
	candidates.push({ command: 'python.exe', argsPrefix: [], source: 'python' });
	return candidates;
}

function discoverPython(config = settings()) {
	for (const candidate of pythonCandidates(config)) {
		if (candidate.command.indexOf(path.sep) !== -1 && !fs.existsSync(candidate.command)) {
			continue;
		}
		if (executableWorks(candidate.command, candidate.argsPrefix)) {
			const version = runSync(candidate.command, [...candidate.argsPrefix, '-c', 'import sys; print(sys.version.split()[0])']);
			return {
				...candidate,
				version: (version.stdout || '').trim(),
				available: true,
			};
		}
	}
	return { available: false, command: '', argsPrefix: [], source: '', version: '' };
}

function venvPythonPath(config = settings()) {
	return process.platform === 'win32'
		? path.join(config.venv_path, 'Scripts', 'python.exe')
		: path.join(config.venv_path, 'bin', 'python');
}

function hasPythonModule(pythonPath, moduleName) {
	if (!pythonPath || !fs.existsSync(pythonPath)) {
		return false;
	}
	const result = runSync(pythonPath, ['-c', `import importlib.util as u; raise SystemExit(0 if u.find_spec("${moduleName}") else 1)`]);
	return !result.error && result.status === 0;
}

function pythonSitePackageDirs(pythonPath) {
	const fallback = [];
	if (pythonPath && fs.existsSync(pythonPath)) {
		const venvRoot = path.dirname(path.dirname(pythonPath));
		if (process.platform === 'win32') {
			fallback.push(path.join(venvRoot, 'Lib', 'site-packages'));
		} else {
			fallback.push(path.join(venvRoot, 'lib'));
		}
		const result = runSync(pythonPath, ['-c', 'import json, site; print(json.dumps(site.getsitepackages() + [site.getusersitepackages()]))']);
		if (!result.error && result.status === 0) {
			try {
				const parsed = JSON.parse(String(result.stdout || '[]'));
				return Array.from(new Set(parsed.concat(fallback).filter((entry) => entry && fs.existsSync(entry))));
			} catch (error) {}
		}
	}
	return fallback.filter((entry) => fs.existsSync(entry));
}

function cudaRuntimeDirs(pythonPath) {
	const dirs = [];
	if (process.env.ALORBACH_ASR_CUDA_PATHS) {
		dirs.push(...String(process.env.ALORBACH_ASR_CUDA_PATHS).split(path.delimiter).filter(Boolean));
	}
	for (const siteDir of pythonSitePackageDirs(pythonPath)) {
		for (const pkg of ['cublas', 'cudnn', 'cuda_runtime']) {
			for (const subdir of ['bin', 'lib']) {
				const candidate = path.join(siteDir, 'nvidia', pkg, subdir);
				if (fs.existsSync(candidate)) {
					dirs.push(candidate);
				}
			}
		}
	}
	return Array.from(new Set(dirs));
}

function envWithPrependedPath(dirs) {
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
	const cleanDirs = Array.from(new Set((dirs || []).filter(Boolean)));
	return {
		...process.env,
		[pathKey]: cleanDirs.concat(process.env[pathKey] || '').join(path.delimiter),
	};
}

function cudaRuntimeInfo(pythonPath) {
	if (!pythonPath || !fs.existsSync(pythonPath)) {
		return { available: false, reason: 'venv_missing', dirs: [], missing: [] };
	}
	const dirs = cudaRuntimeDirs(pythonPath);
	const env = envWithPrependedPath(dirs);
	const dlls = process.platform === 'win32'
		? ['cublas64_12.dll', 'cudnn64_9.dll']
		: ['libcublas.so.12', 'libcudnn.so.9'];
	const missing = dlls.filter((dll) => {
		if (dirs.some((dir) => fs.existsSync(path.join(dir, dll)))) {
			return false;
		}
		if (process.platform === 'win32') {
			const found = runSync('where.exe', [dll], { env });
			return !!found.error || found.status !== 0;
		}
		return true;
	});
	const probeScript = [
		'import json',
		'try:',
		' import ctranslate2',
		' print(json.dumps({"devices": ctranslate2.get_cuda_device_count(), "compute_types": sorted(list(ctranslate2.get_supported_compute_types("cuda"))) }))',
		'except Exception as exc:',
		' print(json.dumps({"error": str(exc)}))',
		' raise SystemExit(1)',
	].join('\n');
	const ctranslate = runSync(pythonPath, ['-c', probeScript], { env });
	let ctranslateInfo = {};
	try {
		ctranslateInfo = JSON.parse(String(ctranslate.stdout || '{}'));
	} catch (error) {}
	const devices = Number(ctranslateInfo.devices || 0) || 0;
	return {
		available: missing.length === 0 && !ctranslate.error && ctranslate.status === 0 && devices > 0,
		reason: missing.length ? `missing ${missing.join(', ')}` : (devices > 0 ? '' : 'no ctranslate2 CUDA device'),
		dirs,
		missing,
		devices,
		compute_types: Array.isArray(ctranslateInfo.compute_types) ? ctranslateInfo.compute_types : [],
		error: ctranslateInfo.error || ctranslate.error && ctranslate.error.message || '',
	};
}

function commandAvailable(command, args = ['--version']) {
	const result = runSync(command, args);
	if (!result.error && result.status === 0) {
		return true;
	}
	if (process.platform === 'win32') {
		const where = runSync('where.exe', [command]);
		return !where.error && where.status === 0 && String(where.stdout || '').trim() !== '';
	}
	return false;
}

function gpuInfo() {
	const result = runSync('nvidia-smi.exe', ['--query-gpu=name,memory.total,memory.free,driver_version', '--format=csv,noheader,nounits']);
	if (result.error || result.status !== 0) {
		return { available: false };
	}
	const line = String(result.stdout || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean)[0] || '';
	const parts = line.split(',').map((item) => item.trim());
	if (!parts.length) {
		return { available: false };
	}
	return {
		available: true,
		name: parts[0] || '',
		total_mb: Number(parts[1] || 0) || 0,
		free_mb: Number(parts[2] || 0) || 0,
		driver_version: parts[3] || '',
	};
}

function probe(config = settings()) {
	const python = discoverPython(config);
	const venvPython = venvPythonPath(config);
	const runtimeInstalled = hasPythonModule(venvPython, 'faster_whisper');
	const venvExists = fs.existsSync(venvPython);
	return {
		python,
		venv_path: config.venv_path,
		venv_python: venvPython,
		venv_exists: venvExists,
		faster_whisper_installed: runtimeInstalled,
		ffmpeg_available: commandAvailable('ffmpeg.exe'),
		ffprobe_available: commandAvailable('ffprobe.exe'),
		gpu: gpuInfo(),
		cuda_runtime: venvExists ? cudaRuntimeInfo(venvPython) : { available: false, reason: 'venv_missing', dirs: [], missing: [] },
	};
}

function probeCacheKey(config) {
	return JSON.stringify({
		python_path: config.python_path || '',
		venv_path: config.venv_path || '',
		cuda_paths: process.env.ALORBACH_ASR_CUDA_PATHS || '',
	});
}

function invalidateProbeCache() {
	probeCache = null;
}

function lightRuntime(config = settings()) {
	const venvPython = venvPythonPath(config);
	return {
		checked: false,
		cached: false,
		python: { available: null, command: config.python_path || '', argsPrefix: [], source: '', version: '' },
		venv_path: config.venv_path,
		venv_python: venvPython,
		venv_exists: fs.existsSync(venvPython),
		faster_whisper_installed: null,
		ffmpeg_available: null,
		ffprobe_available: null,
		gpu: { available: null, checked: false },
		cuda_runtime: { available: null, checked: false, reason: 'not_checked', dirs: [], missing: [] },
	};
}

function cachedProbe(config = settings(), options = {}) {
	const now = Date.now();
	const ttlMs = Math.max(0, Number(options.ttlMs ?? DEFAULT_PROBE_TTL_MS) || 0);
	const key = probeCacheKey(config);
	if (!options.refresh && probeCache && probeCache.key === key && now < probeCache.expiresAt) {
		return { ...probeCache.value, checked: true, cached: true, cache_expires_at: probeCache.expiresAt };
	}
	const value = { ...probe(config), checked: true, cached: false, checked_at: new Date(now).toISOString() };
	probeCache = {
		key,
		value,
		expiresAt: now + ttlMs,
	};
	return { ...value, cache_expires_at: probeCache.expiresAt };
}

function runtimeForOptions(config, options = {}) {
	if (options.hardware) {
		return options.hardware;
	}
	if (options.refresh) {
		return cachedProbe(config, { refresh: true, ttlMs: options.ttlMs });
	}
	if (probeCache && probeCache.key === probeCacheKey(config) && Date.now() < probeCache.expiresAt) {
		return { ...probeCache.value, checked: true, cached: true, cache_expires_at: probeCache.expiresAt };
	}
	return lightRuntime(config);
}

function hfCacheRoots() {
	const roots = [];
	if (process.env.HF_HOME) {
		roots.push(path.join(process.env.HF_HOME, 'hub'));
	}
	if (process.env.HUGGINGFACE_HUB_CACHE) {
		roots.push(process.env.HUGGINGFACE_HUB_CACHE);
	}
	roots.push(path.join(os.homedir(), '.cache', 'huggingface', 'hub'));
	return Array.from(new Set(roots.filter(Boolean)));
}

function repoCacheName(repoId) {
	return `models--${String(repoId || '').replace(/\//g, '--')}`;
}

function newestSnapshot(repoId) {
	for (const root of hfCacheRoots()) {
		const snapshots = path.join(root, repoCacheName(repoId), 'snapshots');
		if (!fs.existsSync(snapshots)) {
			continue;
		}
		const entries = fs.readdirSync(snapshots, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => {
				const fullPath = path.join(snapshots, entry.name);
				let mtime = 0;
				try {
					mtime = fs.statSync(fullPath).mtimeMs;
				} catch (error) {}
				return { path: fullPath, mtime };
			})
			.sort((a, b) => b.mtime - a.mtime);
		if (entries[0]) {
			return entries[0].path;
		}
	}
	return '';
}

function enabledModels(config = settings()) {
	return config.models.filter((entry) => entry && entry.id && entry.enabled !== false);
}

function modelIds(config = settings()) {
	return [MODEL_PREFIX, ...enabledModels(config).map((entry) => fullModelId(entry.id))];
}

function selectModel(requestedModel = MODEL_PREFIX, config = settings(), hardware = probe(config)) {
	const requestedSlug = modelSlug(requestedModel);
	const models = enabledModels(config);
	if (requestedSlug) {
		const explicit = models.find((entry) => entry.id === requestedSlug);
		if (!explicit) {
			return { error: `Unknown or disabled Local Whisper model: ${requestedModel}` };
		}
		return decorateSelection(explicit, config, hardware);
	}
	const sorted = models.slice().sort((a, b) => Number(b.min_vram_mb || 0) - Number(a.min_vram_mb || 0));
	for (const model of sorted) {
		const selected = decorateSelection(model, config, hardware);
		if (selected.model_path || config.allow_model_downloads) {
			return selected;
		}
	}
	return sorted[0] ? decorateSelection(sorted[0], config, hardware) : { error: 'No Local Whisper models are enabled.' };
}

function decorateSelection(model, config, hardware) {
	const gpu = hardware.gpu || {};
	const cudaRuntime = hardware.cuda_runtime || {};
	const cudaUsable = gpu.available && cudaRuntime.available !== false;
	const wouldUseCuda = model.preferred_device === 'cuda' || (model.preferred_device === 'auto' && gpu.available && Number(gpu.free_mb || 0) >= Number(model.min_vram_mb || 0));
	const wantsCuda = wouldUseCuda && cudaUsable;
	const device = wantsCuda ? 'cuda' : 'cpu';
	const repoId = device === 'cuda' && model.gpu_repo_id ? model.gpu_repo_id : model.repo_id;
	const cachedModelPath = resolveModelPath(model, repoId, false);
	const modelPath = cachedModelPath || (config.allow_model_downloads ? (repoId || model.id) : '');
	return {
		...model,
		model_id: fullModelId(model.id),
		device,
		compute_type: device === 'cuda' ? 'float16' : 'int8',
		repo_id: repoId || model.repo_id,
		model_path: modelPath,
		allow_download: config.allow_model_downloads && !cachedModelPath,
		cuda_blocked_reason: wouldUseCuda && !cudaUsable ? (cudaRuntime.reason || 'CUDA runtime unavailable') : '',
	};
}

function candidateModelsForRequest(requestedModel, config) {
	const requestedSlug = modelSlug(requestedModel);
	const models = enabledModels(config);
	if (requestedSlug) {
		return models.filter((entry) => entry.id === requestedSlug);
	}
	return models.slice().sort((a, b) => Number(b.min_vram_mb || 0) - Number(a.min_vram_mb || 0));
}

function requestCouldUseCuda(requestedModel, config, hardware) {
	const gpu = hardware.gpu || {};
	if (!gpu.available) {
		return false;
	}
	return candidateModelsForRequest(requestedModel, config).some((model) => (
		model.preferred_device === 'cuda'
		|| (model.preferred_device === 'auto' && Number(gpu.free_mb || 0) >= Number(model.min_vram_mb || 0))
	));
}

function cpuFallbackSelection(selected, config, hardware) {
	const entry = enabledModels(config).find((model) => model.id === selected.id);
	if (!entry) {
		return { error: `Unknown or disabled Local Whisper model: ${selected.model_id}` };
	}
	return decorateSelection({ ...entry, preferred_device: 'cpu' }, config, {
		...hardware,
		gpu: { available: false },
		cuda_runtime: { available: false, reason: 'CPU fallback requested', dirs: [], missing: [] },
	});
}

function isCudaRuntimeFailure(run) {
	const output = `${run && run.stderr || ''}\n${run && run.stdout || ''}\n${run && run.error && run.error.message || ''}`.toLowerCase();
	return output.includes('cublas') || output.includes('cudnn') || output.includes('cuda') && output.includes('not found');
}

function resolveModelPath(model, repoId, allowDownload) {
	if (model.local_path && fs.existsSync(model.local_path)) {
		return model.local_path;
	}
	const cached = repoId ? newestSnapshot(repoId) : '';
	if (cached) {
		return cached;
	}
	return allowDownload ? (repoId || model.id) : '';
}

function runAsync(command, args, options = {}) {
	const onOutput = typeof options.onOutput === 'function' ? options.onOutput : () => {};
	return new Promise((resolve) => {
		const stdoutCollector = createBoundedCollector({
			maxChars: Number(process.env.ALORBACH_ASR_OUTPUT_MAX_CHARS || 1024 * 1024),
		});
		const stderrCollector = createBoundedCollector({
			maxChars: Number(process.env.ALORBACH_ASR_OUTPUT_MAX_CHARS || 1024 * 1024),
		});
		let spawnError = null;
		let timedOut = false;
		let child;
		try {
			child = spawn(command, args, {
				cwd: options.cwd || undefined,
				windowsHide: true,
				shell: false,
				stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
				env: { ...process.env, ...(options.env || {}) },
			});
		} catch (error) {
			appendLog('server', 'ASR child process spawn failed.', { error: safeError(error), command, args });
			resolve({ stdout: '', stderr: '', status: null, signal: null, error });
			return;
		}
		if (options.input && child.stdin) {
			child.stdin.end(options.input);
		}
		const timer = options.timeout ? setTimeout(() => {
			timedOut = true;
			child.kill();
		}, options.timeout) : null;
		if (timer && typeof timer.unref === 'function') {
			timer.unref();
		}
		child.stdout.on('data', (chunk) => {
			const text = String(chunk || '');
			stdoutCollector.append(text);
			onOutput('stdout', text);
		});
		child.stderr.on('data', (chunk) => {
			const text = String(chunk || '');
			stderrCollector.append(text);
			onOutput('stderr', text);
		});
		child.once('error', (error) => {
			spawnError = error;
		});
		child.once('close', (status, signal) => {
			if (timer) {
				clearTimeout(timer);
			}
			const stdout = stdoutCollector.value();
			const stderr = stderrCollector.value();
			const stdoutStats = stdoutCollector.stats();
			const stderrStats = stderrCollector.stats();
			if (stdoutStats.truncated_chars || stderrStats.truncated_chars) {
				appendLog('server', 'ASR child process output was truncated.', {
					stdout: stdoutStats,
					stderr: stderrStats,
					status,
					signal,
				});
			}
			resolve({ stdout, stderr, status, signal, error: spawnError || (timedOut ? new Error('Local Whisper execution timed out.') : null) });
		});
	});
}

async function ensureRuntime(config = settings(), session = {}) {
	const emit = typeof session.appendSessionOutput === 'function' ? session.appendSessionOutput : () => {};
	const venvPython = venvPythonPath(config);
	if (!fs.existsSync(venvPython)) {
		const python = discoverPython(config);
		if (!python.available) {
			return { success: false, category: 'configuration', code: 'asr_python_missing', message: 'Python 3.10+ was not found for Local Whisper setup.', details: { probe: probe(config) } };
		}
		if (!config.allow_package_install) {
			return { success: false, category: 'configuration', code: 'asr_venv_missing', message: 'Local Whisper Python environment is missing and package installation is disabled.', details: { probe: probe(config) } };
		}
		emit('stdout', `Creating Local Whisper Python environment at ${config.venv_path}\n`);
		fs.mkdirSync(path.dirname(config.venv_path), { recursive: true });
		const created = await runAsync(python.command, [...python.argsPrefix, '-m', 'venv', config.venv_path], { timeout: 600000, onOutput: emit });
		if (created.error || created.status !== 0) {
			return { success: false, category: 'configuration', code: 'asr_venv_failed', message: 'Local Whisper Python environment could not be created.', details: created };
		}
	}
	if (!hasPythonModule(venvPython, 'faster_whisper')) {
		if (!config.allow_package_install) {
			return { success: false, category: 'configuration', code: 'asr_runtime_missing', message: 'faster-whisper is not installed and package installation is disabled.', details: { probe: probe(config) } };
		}
		emit('stdout', 'Installing faster-whisper in the Local Whisper Python environment.\n');
		const installed = await runAsync(venvPython, ['-m', 'pip', 'install', '--progress-bar', 'off', 'faster-whisper'], { timeout: 1800000, onOutput: emit });
		if (installed.error || installed.status !== 0) {
			return { success: false, category: 'configuration', code: 'asr_runtime_install_failed', message: 'faster-whisper could not be installed.', details: installed };
		}
	}
	return { success: true, python: venvPython };
}

async function ensureCudaRuntime(config = settings(), pythonPath, session = {}) {
	const emit = typeof session.appendSessionOutput === 'function' ? session.appendSessionOutput : () => {};
	let info = cudaRuntimeInfo(pythonPath);
	if (info.available) {
		return { success: true, installed: false, cuda_runtime: info };
	}
	if (!config.allow_package_install) {
		return { success: false, installed: false, cuda_runtime: info, message: `CUDA runtime packages are missing: ${info.reason || 'runtime unavailable'}` };
	}
	emit('stdout', `Installing Local Whisper CUDA runtime packages (${info.reason || 'CUDA DLLs missing'}).\n`);
	const installed = await runAsync(pythonPath, ['-m', 'pip', 'install', '--progress-bar', 'off', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12'], { timeout: 1800000, onOutput: emit });
	if (installed.error || installed.status !== 0) {
		return { success: false, installed: false, cuda_runtime: info, message: 'CUDA runtime packages could not be installed.', details: installed };
	}
	info = cudaRuntimeInfo(pythonPath);
	return { success: info.available, installed: true, cuda_runtime: info, message: info.available ? '' : `CUDA runtime packages are installed but unusable: ${info.reason || 'runtime unavailable'}` };
}

async function transcribe(payload, session = {}) {
	const audioBase64 = String(payload.audio_base64 || '');
	if (!audioBase64 || audioBase64.length > MAX_AUDIO_BASE64_LENGTH) {
		return { success: false, category: 'validation', message: 'Audio payload is missing or too large.' };
	}
	const config = settings();
	const requestedModel = payload.model || MODEL_PREFIX;
	const requestedSlug = modelSlug(requestedModel);
	if (requestedSlug && !enabledModels(config).some((model) => model.id === requestedSlug)) {
		return { success: false, category: 'validation', code: 'asr_model_unavailable', message: `Unknown or disabled Local Whisper model: ${requestedModel}` };
	}
	let audioBytes;
	try {
		audioBytes = Buffer.from(audioBase64, 'base64');
	} catch (error) {
		return { success: false, category: 'validation', message: 'Audio payload is not valid base64.' };
	}
	if (!audioBytes.length) {
		return { success: false, category: 'validation', message: 'Audio payload is empty.' };
	}
	const runtime = await ensureRuntime(config, session);
	if (!runtime.success) {
		return runtime;
	}
	let hardware = probe(config);
	if (requestCouldUseCuda(requestedModel, config, hardware) && !(hardware.cuda_runtime || {}).available) {
		const cudaRuntime = await ensureCudaRuntime(config, runtime.python, session);
		if (!cudaRuntime.success && typeof session.appendSessionOutput === 'function') {
			session.appendSessionOutput('stderr', `${cudaRuntime.message || 'CUDA runtime unavailable; falling back to CPU.'}\n`);
		}
		hardware = probe(config);
	}
	let selected = selectModel(requestedModel, config, hardware);
	if (selected.error) {
		return { success: false, category: 'validation', code: 'asr_model_unavailable', message: selected.error };
	}
	if (!selected.model_path) {
		return { success: false, category: 'configuration', code: 'asr_model_missing', message: `Local Whisper model ${selected.model_id} is not cached or configured. Enable model downloads or set a local model path in the bridge status page.`, details: { selected, hardware } };
	}
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alorbach-whisper-transcribe-'));
	const audioPath = path.join(tempDir, `audio.${audioExtensionForFormat(payload.audio_format)}`);
	fs.writeFileSync(audioPath, audioBytes);
	async function runSelected(modelSelection) {
		const request = {
			audio_path: audioPath,
			model: modelSelection.model_path,
			device: modelSelection.device,
			compute_type: modelSelection.compute_type,
			allow_download: modelSelection.allow_download,
			language: payload.language || payload.locale || '',
			cpu_threads: config.cpu_threads,
			num_workers: config.num_workers,
			beam_size: config.beam_size,
			best_of: config.best_of,
			vad_filter: config.vad_filter,
			condition_on_previous_text: config.condition_on_previous_text,
		};
		if (typeof session.appendSessionOutput === 'function') {
			session.appendSessionOutput('stdout', `Local Whisper ${modelSelection.model_id} on ${modelSelection.device}/${modelSelection.compute_type}\n`);
		}
		return runAsync(runtime.python, [RUNNER_PATH], {
			cwd: tempDir,
			timeout: DEFAULT_TIMEOUT_MS,
			input: JSON.stringify(request),
			env: modelSelection.device === 'cuda' ? envWithPrependedPath((hardware.cuda_runtime || {}).dirs || []) : undefined,
			onOutput: session.appendSessionOutput,
		});
	}
	let run = await runSelected(selected);
	if ((run.error || run.status !== 0) && selected.device === 'cuda' && isCudaRuntimeFailure(run)) {
		const fallback = cpuFallbackSelection(selected, config, hardware);
		if (!fallback.error && fallback.model_path) {
			if (typeof session.appendSessionOutput === 'function') {
				session.appendSessionOutput('stderr', 'CUDA runtime failed while loading Local Whisper; retrying on CPU/int8.\n');
			}
			selected = fallback;
			run = await runSelected(selected);
		}
	}
	if (run.error || run.status !== 0) {
		return { success: false, category: 'asr_runtime', code: 'asr_transcribe_failed', message: 'Local Whisper transcription failed.', details: { stdout: run.stdout, stderr: run.stderr, status: run.status, signal: run.signal, error: run.error && run.error.message, selected } };
	}
	let parsed;
	try {
		parsed = JSON.parse(String(run.stdout || '').trim());
	} catch (error) {
		return { success: false, category: 'output_detection', code: 'asr_invalid_output', message: 'Local Whisper did not return valid JSON.', details: { stdout: run.stdout, stderr: run.stderr } };
	}
	const words = Array.isArray(parsed.words) ? parsed.words.filter((item) => item && item.word && Number.isFinite(Number(item.start)) && Number.isFinite(Number(item.end))).map((item) => ({
		word: String(item.word).trim(),
		start: Number(item.start),
		end: Number(item.end),
	})) : [];
	if (!words.length) {
		return { success: false, category: 'output_detection', code: 'asr_transcription_missing_timestamps', message: 'Local Whisper transcription did not return explicit per-word start and end timing.', details: { stdout: run.stdout, stderr: run.stderr } };
	}
	return {
		success: true,
		response: {
			text: String(parsed.text || '').trim() || words.map((item) => item.word).join(' '),
			words,
			model: selected.model_id,
			duration_seconds: Number(payload.duration_seconds || parsed.duration || 0) || undefined,
			local_codex: true,
			provider_details: {
				asr_provider: 'faster-whisper',
				language: parsed.language || undefined,
				language_probability: parsed.language_probability ?? undefined,
				device: selected.device,
				compute_type: selected.compute_type,
				model_path: selected.model_path,
			},
		},
	};
}

function models(options = {}) {
	const config = settings();
	const hardware = runtimeForOptions(config, options);
	const details = {};
	for (const entry of enabledModels(config)) {
		const selected = selectModel(fullModelId(entry.id), config, hardware);
		if (!selected.error) {
			details[selected.model_id] = {
				model_id: selected.model_id,
				label: selected.label,
				device: selected.device,
				compute_type: selected.compute_type,
				model_path: selected.model_path,
				min_vram_mb: selected.min_vram_mb,
				preferred_device: selected.preferred_device,
				repo_id: selected.repo_id,
				ready: !!selected.model_path,
				allow_download: !!selected.allow_download,
				cuda_blocked_reason: selected.cuda_blocked_reason || '',
			};
		}
	}
	return {
		success: true,
		models: modelIds(config),
		labels: Object.fromEntries(enabledModels(config).map((entry) => [fullModelId(entry.id), entry.label])),
		model_details: details,
	};
}

function capabilities(options = {}) {
	const config = settings();
	const hardware = runtimeForOptions(config, options);
	const auto = selectModel(MODEL_PREFIX, config, hardware);
	const modelPayload = models({ ...options, hardware });
	const runtimeChecked = hardware.checked !== false;
	const runtimeReady = runtimeChecked
		? hardware.venv_exists && hardware.faster_whisper_installed
		: null;
	return {
		enabled: true,
		ready: runtimeReady === null ? null : runtimeReady && !!auto.model_path,
		runtime_checked: runtimeChecked,
		runtime_cached: !!hardware.cached,
		auto_model: auto.model_id || MODEL_PREFIX,
		selected_device: auto.error ? null : auto.device,
		selected_compute_type: auto.error ? null : auto.compute_type,
		models: modelPayload.models,
		model_details: modelPayload.model_details,
		settings: config,
		runtime: hardware,
		selected: auto.error ? null : auto,
	};
}

function publicSettings(options = {}) {
	return {
		success: true,
		settings: settings(),
		capabilities: capabilities(options),
	};
}

module.exports = {
	MODEL_PREFIX,
	DEFAULT_MODELS,
	capabilities,
	defaultSettings,
	discoverPython,
	enabledModels,
	ensureRuntime,
	fullModelId,
	modelIds,
	modelSlug,
	models,
	normalizeSettings,
	probe,
	cachedProbe,
	invalidateProbeCache,
	lightRuntime,
	publicSettings,
	resolveModelPath,
	saveSettings,
	selectModel,
	settings,
	transcribe,
	cudaRuntimeDirs,
	cudaRuntimeInfo,
	venvPythonPath,
};
