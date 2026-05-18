'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { app, clipboard, Menu, nativeImage, shell, Tray } = require('electron');
const packageInfo = require('../package.json');
const codex = require('./codex');
const security = require('./security');

let buildInfo = {};
try {
	buildInfo = require('./build-info.json');
} catch (error) {
	buildInfo = { version: packageInfo.version, build_number: 'dev', build_version: packageInfo.version };
}

let tray = null;
let serverProcess = null;
let serverPort = Number(process.env.ALORBACH_CODEX_BRIDGE_PORT || 8765);
let currentPairingCode = '';
let bridgeState = 'Starting';
let lastServerError = '';
let cachedCodexStatus = { success: false, message: 'Checking Codex status...', details: {} };
let jobState = { running_count: 0, queued_count: 0, max_concurrent: 2, active: [], queued: [], recent: [] };
let trayIcons = {};
let currentTrayIconKey = '';
let trayAnimationTimer = null;
let trayAnimationFrame = 0;

const activeAnimationFrameCount = 6;

function loadTrayIcon(name = 'idle') {
	const assetName = name === 'idle' ? 'tray-icon.png' : `tray-${name}.png`;
	const candidates = [
		path.join(__dirname, '..', 'assets', assetName),
		path.join(__dirname, '..', 'assets', 'tray-icon.png'),
	];
	for (const iconPath of candidates) {
		const icon = nativeImage.createFromPath(iconPath);
		if (!icon.isEmpty()) {
			return icon.resize({ width: 16, height: 16 });
		}
	}
	const fallbackPath = path.join(__dirname, '..', 'assets', 'icon.ico');
	const fallback = nativeImage.createFromPath(fallbackPath);
	if (!fallback.isEmpty()) {
		return fallback.resize({ width: 16, height: 16 });
	}
	return nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR4AWMYNmzYf2RgYGBg+P//PwM1ARMDlcGogaMGjhowasCoAQB2pQMe98LPUQAAAABJRU5ErkJggg==');
}

function trayIcon(name) {
	if (!trayIcons[name]) {
		trayIcons[name] = loadTrayIcon(name);
	}
	return trayIcons[name];
}

function shortPath(value) {
	const text = String(value || '');
	return text.length > 52 ? '...' + text.slice(-49) : text;
}

function shortText(value, maxLength = 42) {
	const text = String(value || '').trim();
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function formatElapsed(ms) {
	const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function bridgeUrl() {
	return `http://127.0.0.1:${serverPort}`;
}

function statusPageUrl() {
	return `${bridgeUrl()}/status`;
}

function displayVersion() {
	const build = buildInfo.build_number || 'dev';
	return `${buildInfo.version || packageInfo.version} (${build})`;
}

function openStatusPage() {
	if (bridgeState === 'Running') {
		shell.openExternal(statusPageUrl());
	}
}

function refreshCodexStatus() {
	setTimeout(() => {
		cachedCodexStatus = codex.checkStatus();
		refreshTray();
	}, 0);
}

function copyDiagnostics(status, pairedOrigins) {
	const pairings = security.getPairings();
	const safePairings = {};
	for (const origin of Object.keys(pairings)) {
		safePairings[origin] = {
			paired_at: pairings[origin].paired_at || '',
		};
	}
	clipboard.writeText(JSON.stringify({
		app: packageInfo.productName || 'Codex Local Bridge',
		version: buildInfo.version || packageInfo.version,
		build_number: buildInfo.build_number || 'dev',
		build_version: buildInfo.build_version || '',
		bridge_state: bridgeState,
		bridge_url: bridgeUrl(),
		last_server_error: lastServerError,
		codex_status: status,
		jobs: jobState,
		paired_origins: pairedOrigins,
		pairings: safePairings,
		state_path: security.statePath,
	}, null, 2));
}

function stopBridge() {
	if (!serverProcess) {
		return Promise.resolve();
	}
	const child = serverProcess;
	serverProcess = null;
	return new Promise((resolve) => {
		const timeout = setTimeout(resolve, 2500);
		child.once('exit', () => {
			clearTimeout(timeout);
			resolve();
		});
		child.kill();
	});
}

function startBridge() {
	return new Promise((resolve) => {
		bridgeState = 'Starting';
		lastServerError = '';
		refreshTray();
		const serverScript = path.join(__dirname, 'server.js');
		const child = fork(serverScript, [`--port=${serverPort}`], {
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: '1',
			},
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		});
		serverProcess = child;

		child.stdout.on('data', (chunk) => {
			const text = String(chunk || '').trim();
			if (text) {
				lastServerError = '';
			}
		});
		child.stderr.on('data', (chunk) => {
			const text = String(chunk || '').trim();
			if (text) {
				lastServerError = text;
			}
		});
		child.on('message', (message) => {
			if (!message || typeof message !== 'object') {
				return;
			}
			if (message.type === 'ready') {
				serverPort = Number(message.port || serverPort);
				currentPairingCode = String(message.pairingCode || currentPairingCode || '');
				bridgeState = 'Running';
				refreshTray();
				resolve();
			} else if (message.type === 'pairing-code') {
				currentPairingCode = String(message.pairingCode || currentPairingCode || '');
				refreshTray();
			} else if (message.type === 'error') {
				lastServerError = String(message.message || '');
				bridgeState = 'Failed';
				refreshTray();
			} else if (message.type === 'job-state') {
				jobState = {
					running_count: Number(message.jobs && message.jobs.running_count) || 0,
					queued_count: Number(message.jobs && message.jobs.queued_count) || 0,
					max_concurrent: Number(message.jobs && message.jobs.max_concurrent) || 1,
					active: Array.isArray(message.jobs && message.jobs.active) ? message.jobs.active : [],
					queued: Array.isArray(message.jobs && message.jobs.queued) ? message.jobs.queued : [],
					recent: Array.isArray(message.jobs && message.jobs.recent) ? message.jobs.recent : [],
				};
				refreshTray();
			}
		});
		child.once('exit', (code) => {
			if (serverProcess === child) {
				serverProcess = null;
				bridgeState = code === 0 ? 'Stopped' : 'Stopped unexpectedly';
				refreshTray();
			}
			resolve();
		});
	});
}

async function restartBridge() {
	bridgeState = 'Restarting';
	refreshTray();
	await stopBridge();
	await startBridge();
}

function buildPairedSitesMenu(pairedOrigins) {
	if (!pairedOrigins.length) {
		return [{ label: 'No paired WordPress sites', enabled: false }];
	}
	return pairedOrigins.flatMap((origin) => [
		{
			label: origin,
			click: () => clipboard.writeText(origin),
		},
		{
			label: 'Unpair this site',
			click: () => {
				security.removePairing(origin);
				refreshTray();
			},
		},
		{ type: 'separator' },
	]).slice(0, -1);
}

function jobLabel(job) {
	const id = job.short_request_id || job.request_id || job.id || 'job';
	const model = job.model ? ` ${shortText(job.model, 28)}` : '';
	return `${id}: ${job.type}${model} (${formatElapsed(job.elapsed_ms)})`;
}

function buildJobMenuItems() {
	const items = [
		{ label: `Jobs: Running ${jobState.running_count || 0} / Queued ${jobState.queued_count || 0}`, enabled: false },
	];
	if (jobState.active && jobState.active.length) {
		for (const job of jobState.active.slice(0, 5)) {
			items.push({ label: `Running: ${jobLabel(job)}`, enabled: false });
		}
	}
	if (jobState.queued && jobState.queued.length) {
		for (const job of jobState.queued.slice(0, 5)) {
			const id = job.short_request_id || job.request_id || job.id || 'job';
			const model = job.model ? ` ${shortText(job.model, 28)}` : '';
			items.push({ label: `Queued: ${id}: ${job.type}${model}`, enabled: false });
		}
	}
	return items;
}

function buildMenu() {
	const status = cachedCodexStatus;
	const pairedOrigins = Object.keys(security.getPairings());
	const details = status.details || {};
	const codexLabel = status.success ? 'Codex: Ready' : 'Codex: Needs attention';
	return Menu.buildFromTemplate([
		{ label: `Codex Local Bridge ${displayVersion()}`, enabled: false },
		{ label: `Bridge: ${bridgeState}`, enabled: false },
		{ label: `URL: ${bridgeUrl()}`, enabled: false },
		{ label: codexLabel, enabled: false },
		{ label: status.message || 'Status unavailable', enabled: false },
		...buildJobMenuItems(),
		{ type: 'separator' },
		{ label: `Pairing code: ${currentPairingCode || 'starting'}`, enabled: false },
		{
			label: 'Copy pairing code',
			enabled: !!currentPairingCode,
			click: () => clipboard.writeText(currentPairingCode || ''),
		},
		{
			label: 'Copy bridge URL',
			click: () => clipboard.writeText(bridgeUrl()),
		},
		{
			label: 'Copy diagnostics',
			click: () => copyDiagnostics(status, pairedOrigins),
		},
		{
			label: 'Refresh Codex status',
			click: () => refreshCodexStatus(),
		},
		{
			label: 'Open status page',
			enabled: bridgeState === 'Running',
			click: () => openStatusPage(),
		},
		{
			label: 'Open status JSON',
			enabled: bridgeState === 'Running',
			click: () => shell.openExternal(bridgeUrl() + '/v1/status'),
		},
		{
			label: 'Open bridge data folder',
			click: () => {
				fs.mkdirSync(security.stateDir, { recursive: true });
				shell.openPath(security.stateDir);
			},
		},
		{
			label: 'Launch on login',
			type: 'checkbox',
			checked: app.getLoginItemSettings().openAtLogin,
			click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
		},
		{ type: 'separator' },
		{
			label: 'Codex details',
			submenu: [
				{ label: `Binary: ${shortPath(details.codex_binary || 'not found')}`, enabled: false },
				{ label: `Home: ${shortPath(details.codex_home || '')}`, enabled: false },
				{ label: `Version: ${shortPath(details.version || 'unknown')}`, enabled: false },
				{
					label: 'Copy Codex binary path',
					enabled: !!details.codex_binary,
					click: () => clipboard.writeText(details.codex_binary || ''),
				},
			],
		},
		{
			label: 'Open Codex login help',
			click: () => shell.openExternal('https://help.openai.com/'),
		},
		{ type: 'separator' },
		{
			label: `Paired WordPress sites (${pairedOrigins.length})`,
			submenu: buildPairedSitesMenu(pairedOrigins),
		},
		{ type: 'separator' },
		{ label: 'Restart bridge', click: () => restartBridge() },
		{ type: 'separator' },
		{ label: 'Quit', click: () => app.quit() },
	]);
}

function trayIconName() {
	const failedState = /failed|unexpected/i.test(bridgeState);
	if (failedState) {
		return 'error';
	}
	const stoppedState = /stopped|starting|restart/i.test(bridgeState);
	if (stoppedState) {
		return 'stopped';
	}
	const recentFailure = (jobState.recent || []).some((job) => {
		const finishedAt = Number(job.finished_at || 0);
		return job.status === 'failed' && finishedAt && Date.now() - finishedAt < 120000;
	});
	if (recentFailure) {
		return 'error';
	}
	if ((jobState.running_count || 0) > 0) {
		return 'active';
	}
	if ((jobState.queued_count || 0) > 0) {
		return 'queued';
	}
	return 'idle';
}

function setTrayIcon(name) {
	if (!tray || name === currentTrayIconKey) {
		return;
	}
	tray.setImage(trayIcon(name));
	currentTrayIconKey = name;
}

function stopTrayAnimation() {
	if (trayAnimationTimer) {
		clearInterval(trayAnimationTimer);
		trayAnimationTimer = null;
	}
	trayAnimationFrame = 0;
}

function animateTrayIcon() {
	const frameName = `active-${trayAnimationFrame % activeAnimationFrameCount}`;
	setTrayIcon(frameName);
	trayAnimationFrame += 1;
}

function updateTrayIcon() {
	const iconName = trayIconName();
	if (iconName === 'active') {
		if (!trayAnimationTimer) {
			animateTrayIcon();
			trayAnimationTimer = setInterval(animateTrayIcon, 450);
			if (typeof trayAnimationTimer.unref === 'function') {
				trayAnimationTimer.unref();
			}
		}
		return;
	}
	stopTrayAnimation();
	setTrayIcon(iconName);
}

function refreshTray() {
	if (!tray) {
		return;
	}
	const activeJobs = (jobState.active || []).slice(0, 3).map((job) => {
		const id = job.short_request_id || job.request_id || job.id || 'job';
		const model = job.model ? ` ${shortText(job.model, 24)}` : '';
		return `${id}: ${job.type}${model} ${formatElapsed(job.elapsed_ms)}`;
	});
	updateTrayIcon();
	const tooltip = [
		'Codex Local Bridge',
		`Bridge: ${bridgeState}`,
		bridgeUrl(),
		`Codex: ${cachedCodexStatus.success ? 'Ready' : 'Needs attention'}`,
		`Running: ${jobState.running_count || 0} / Queued: ${jobState.queued_count || 0}`,
		...activeJobs,
		`Pairing code: ${currentPairingCode || 'starting'}`,
	].join('\n');
	tray.setToolTip(tooltip);
	tray.setContextMenu(buildMenu());
}

async function boot() {
	tray = new Tray(trayIcon('idle'));
	tray.on('double-click', () => openStatusPage());
	refreshTray();
	await startBridge();
	refreshCodexStatus();
	setInterval(refreshCodexStatus, 60000).unref();
	setInterval(refreshTray, 15000).unref();
}

app.whenReady().then(boot);

app.on('before-quit', () => {
	stopTrayAnimation();
	if (serverProcess) {
		serverProcess.kill();
		serverProcess = null;
	}
});

app.on('window-all-closed', (event) => {
	event.preventDefault();
});
