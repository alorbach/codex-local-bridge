'use strict';

function statusPageHtml() {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Codex Local Bridge Status</title>
	<style>
		:root {
			color-scheme: dark;
			--bg: #0b0f14;
			--panel: #121923;
			--panel-2: #172231;
			--line: #263445;
			--text: #edf4fb;
			--muted: #9cadbf;
			--ok: #34d399;
			--warn: #fbbf24;
			--bad: #fb7185;
			--info: #60a5fa;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			background: var(--bg);
			color: var(--text);
			font: 14px/1.45 "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
			overflow-x: hidden;
		}
		main {
			width: min(1120px, calc(100vw - 32px));
			margin: 24px auto;
			overflow-x: hidden;
		}
		header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			margin-bottom: 18px;
		}
		h1 {
			margin: 0;
			font-size: 24px;
			font-weight: 650;
			letter-spacing: 0;
		}
		.updated {
			color: var(--muted);
			font-size: 12px;
			white-space: nowrap;
		}
		.grid {
			display: grid;
			grid-template-columns: repeat(12, 1fr);
			gap: 12px;
			min-width: 0;
		}
		.panel {
			background: var(--panel);
			border: 1px solid var(--line);
			border-radius: 8px;
			padding: 14px;
			min-width: 0;
			max-width: 100%;
			overflow: hidden;
		}
		.span-4 { grid-column: span 4; }
		.span-6 { grid-column: span 6; }
		.span-12 { grid-column: span 12; }
		.label {
			color: var(--muted);
			font-size: 12px;
			margin-bottom: 6px;
		}
		.value {
			font-size: 18px;
			font-weight: 650;
			overflow-wrap: anywhere;
		}
		.pill {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			border-radius: 999px;
			padding: 6px 10px;
			background: var(--panel-2);
			border: 1px solid var(--line);
			font-weight: 650;
		}
		.dot {
			width: 9px;
			height: 9px;
			border-radius: 50%;
			background: var(--muted);
		}
		.ok .dot { background: var(--ok); }
		.warn .dot { background: var(--warn); }
		.bad .dot { background: var(--bad); }
		.table {
			width: 100%;
			border-collapse: collapse;
			table-layout: fixed;
		}
		.table th,
		.table td {
			border-bottom: 1px solid var(--line);
			padding: 9px 8px;
			text-align: left;
			vertical-align: top;
			overflow-wrap: anywhere;
			word-break: break-word;
		}
		.table th {
			color: var(--muted);
			font-size: 12px;
			font-weight: 600;
		}
		.table tr:last-child td { border-bottom: 0; }
		.muted { color: var(--muted); }
		.help-list {
			margin: 0;
			padding-left: 18px;
			color: var(--muted);
		}
		.help-list li { margin: 4px 0; }
		.feature-grid {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 8px;
		}
		.feature-pill {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			min-width: 0;
			background: var(--panel-2);
			border: 1px solid var(--line);
			border-radius: 6px;
			padding: 9px 10px;
		}
		.feature-pill .name {
			overflow-wrap: anywhere;
		}
		.feature-pill .state {
			flex: 0 0 auto;
			color: var(--muted);
			font-size: 12px;
			font-weight: 650;
		}
		.feature-pill.enabled .state { color: var(--ok); }
		.feature-pill.disabled .state { color: var(--bad); }
		.session-output-block {
			min-width: 0;
		}
		.session-output-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			margin-bottom: 8px;
		}
		.copy-session-output {
			appearance: none;
			border: 1px solid var(--line);
			border-radius: 6px;
			background: var(--panel-2);
			color: var(--text);
			cursor: pointer;
			font: inherit;
			font-size: 12px;
			line-height: 1;
			padding: 7px 10px;
			white-space: nowrap;
		}
		.copy-session-output:hover,
		.copy-session-output:focus-visible {
			border-color: var(--info);
			outline: none;
		}
		details.panel {
			padding: 0;
		}
		summary {
			cursor: pointer;
			list-style: none;
			padding: 14px;
			color: var(--muted);
			font-size: 12px;
			user-select: none;
		}
		summary::-webkit-details-marker { display: none; }
		summary::before {
			content: ">";
			display: inline-block;
			margin-right: 8px;
			color: var(--text);
			transition: transform 0.15s ease;
		}
		details[open] summary::before {
			transform: rotate(90deg);
		}
		code {
			color: #d7e7ff;
			background: #0e1520;
			border: 1px solid var(--line);
			border-radius: 5px;
			padding: 2px 5px;
			overflow-wrap: anywhere;
		}
		pre {
			margin: 0;
			padding: 12px;
			background: #0e1520;
			border: 1px solid var(--line);
			border-radius: 8px;
			color: #d7e7ff;
			overflow: auto;
			max-height: 320px;
			font-size: 12px;
			max-width: 100%;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
			word-break: break-word;
		}
		.session-output {
			max-height: 260px;
		}
		.live-session-output {
			scroll-behavior: smooth;
		}
		.raw-status {
			border-width: 1px 0 0;
			border-radius: 0;
			max-height: 420px;
		}
		@media (max-width: 760px) {
			main { width: min(100% - 20px, 1080px); margin-top: 12px; }
			header { align-items: flex-start; flex-direction: column; }
			.span-4,
			.span-6 { grid-column: span 12; }
			.feature-grid { grid-template-columns: 1fr; }
			.table { display: block; overflow-x: auto; }
		}
	</style>
</head>
<body>
	<main>
		<header>
			<h1>Codex Local Bridge</h1>
			<div class="updated" id="updated">Loading</div>
		</header>
		<section class="grid">
			<div class="panel span-4">
				<div class="label">Bridge</div>
				<div class="value"><span class="pill" id="bridgePill"><span class="dot"></span><span>Checking</span></span></div>
			</div>
			<div class="panel span-4">
				<div class="label">Codex</div>
				<div class="value"><span class="pill" id="codexPill"><span class="dot"></span><span>Checking</span></span></div>
			</div>
			<div class="panel span-4">
				<div class="label">Jobs</div>
				<div class="value" id="jobCounts">Running 0 / Queued 0</div>
			</div>
			<div class="panel span-6">
				<div class="label">Bridge Version</div>
				<div class="value" id="version">-</div>
			</div>
			<div class="panel span-6">
				<div class="label">Max Parallel Jobs</div>
				<div class="value" id="maxConcurrent">-</div>
			</div>
			<div class="panel span-6">
				<div class="label">Codex CLI Version</div>
				<div class="value" id="codexCliVersion">-</div>
			</div>
			<div class="panel span-6">
				<div class="label">Codex Binary</div>
				<div class="value"><code id="codexBinary">-</code></div>
			</div>
			<div class="panel span-12">
				<div class="label">Detected Features</div>
				<div class="feature-grid" id="detectedFeatures"></div>
			</div>
			<div class="panel span-12">
				<div class="label">Active Jobs</div>
				<table class="table">
					<thead><tr><th>Request</th><th>Type</th><th>Model</th><th>Status</th><th>Elapsed</th></tr></thead>
					<tbody id="activeJobs"><tr><td colspan="5" class="muted">No active jobs</td></tr></tbody>
				</table>
			</div>
			<div class="panel span-12">
				<div class="label">Recent Failures</div>
				<table class="table">
					<thead><tr><th>Request</th><th>Type</th><th>Model</th><th>Error</th><th>Finished</th></tr></thead>
					<tbody id="recentFailures"><tr><td colspan="5" class="muted">No recent failures</td></tr></tbody>
				</table>
			</div>
			<div class="panel span-12">
				<div class="label">Paired Sites</div>
				<div id="pairedSites" class="muted">None</div>
			</div>
			<div class="panel span-12">
				<div class="label">Debug Help</div>
				<ul class="help-list">
					<li>Check this page after a failed request; recent failed jobs and Codex session output appear above.</li>
					<li>Use the tray menu Copy diagnostics action for a safe diagnostic payload without bearer tokens.</li>
					<li>Run <code>codex login status</code> in the same Windows account as the tray app.</li>
					<li>Confirm the browser origin is paired and the request includes the bridge token.</li>
					<li>Use <code>/v1/status</code> for the raw status JSON included in failure debug output.</li>
				</ul>
			</div>
			<div class="panel span-12">
				<div class="label">Codex Details</div>
				<table class="table">
					<tbody id="codexDetails"></tbody>
				</table>
			</div>
			<details class="panel span-12">
				<summary>Raw Status</summary>
				<pre class="raw-status" id="rawStatus">{}</pre>
			</details>
		</section>
	</main>
	<script>
		const statusUrl = '/v1/status';
		const capabilitiesUrl = '/v1/capabilities';
		const jobEventsUrl = '/v1/status/events';
		let currentStatus = {};
		let currentCapabilities = {};
		let fallbackPollTimer = null;
		let jobEvents = null;
		const fields = {
			updated: document.getElementById('updated'),
			bridgePill: document.getElementById('bridgePill'),
			codexPill: document.getElementById('codexPill'),
			jobCounts: document.getElementById('jobCounts'),
			version: document.getElementById('version'),
			maxConcurrent: document.getElementById('maxConcurrent'),
			codexCliVersion: document.getElementById('codexCliVersion'),
			codexBinary: document.getElementById('codexBinary'),
			detectedFeatures: document.getElementById('detectedFeatures'),
			activeJobs: document.getElementById('activeJobs'),
			recentFailures: document.getElementById('recentFailures'),
			pairedSites: document.getElementById('pairedSites'),
			codexDetails: document.getElementById('codexDetails'),
			rawStatus: document.getElementById('rawStatus'),
		};

		function text(value, fallback = '-') {
			const normalized = String(value ?? '').trim();
			return normalized || fallback;
		}

		function escapeHtml(value) {
			return text(value, '').replace(/[&<>"']/g, (char) => ({
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&#39;',
			}[char]));
		}

		function elapsed(ms) {
			const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
			const minutes = Math.floor(seconds / 60);
			return minutes > 0 ? minutes + 'm ' + (seconds % 60) + 's' : seconds + 's';
		}

		function setPill(element, state, label) {
			element.className = 'pill ' + state;
			element.querySelector('span:last-child').textContent = label;
		}

		function sessionOutputBlock(label, options = {}) {
			const live = !!options.live;
			const key = text(options.key, '');
			return '<div class="session-output-block">' +
				'<div class="session-output-header">' +
					'<div class="label">' + escapeHtml(label) + '</div>' +
					'<button type="button" class="copy-session-output">Copy</button>' +
				'</div>' +
				'<pre class="session-output' + (live ? ' live-session-output' : '') + '" data-session-key="' + escapeHtml(key) + '"></pre>' +
			'</div>';
		}

		function rowFor(tbody, key, kind) {
			return Array.from(tbody.querySelectorAll('tr[data-session-row-key]')).find((row) => (
				row.dataset.sessionRowKey === key && row.dataset.sessionRowKind === kind
			));
		}

		function createSessionRow(key, kind) {
			const row = document.createElement('tr');
			row.dataset.sessionRowKey = key;
			row.dataset.sessionRowKind = kind;
			return row;
		}

		function jobKey(prefix, job) {
			return prefix + ':' + text(job.request_id || job.id || job.short_request_id);
		}

		function activeSummaryCells(job) {
			return '<td><code>' + escapeHtml(job.short_request_id || job.request_id || job.id) + '</code></td>' +
				'<td>' + escapeHtml(job.type) + '</td>' +
				'<td>' + escapeHtml(job.model) + '</td>' +
				'<td>' + escapeHtml(job.status) + '</td>' +
				'<td>' + elapsed(job.elapsed_ms) + '</td>';
		}

		function failureSummaryCells(job) {
			return '<td><code>' + escapeHtml(job.short_request_id || job.request_id || job.id) + '</code></td>' +
				'<td>' + escapeHtml(job.type) + '</td>' +
				'<td>' + escapeHtml(job.model) + '</td>' +
				'<td>' + escapeHtml(job.error_message || 'Request failed') + '</td>' +
				'<td>' + (job.finished_at ? new Date(job.finished_at).toLocaleTimeString() : '-') + '</td>';
		}

		function updateSessionOutput(output, nextValue) {
			const next = text(nextValue, '');
			const current = output.textContent || '';
			if (next === current) {
				return;
			}
			if (next.startsWith(current)) {
				output.appendChild(document.createTextNode(next.slice(current.length)));
				return;
			}
			output.textContent = next;
		}

		function renderJobTable(tbody, jobs, options) {
			const visibleJobs = options.filter ? jobs.filter(options.filter) : jobs;
			if (!visibleJobs.length) {
				tbody.innerHTML = '<tr><td colspan="5" class="muted">' + escapeHtml(options.emptyText) + '</td></tr>';
				return;
			}

			const wanted = new Set();
			Array.from(tbody.children).forEach((row) => {
				if (!row.dataset.sessionRowKey) {
					row.remove();
				}
			});

			for (const job of visibleJobs) {
				const key = jobKey(options.keyPrefix, job);
				wanted.add(key);

				let summaryRow = rowFor(tbody, key, 'summary');
				if (!summaryRow) {
					summaryRow = createSessionRow(key, 'summary');
				}
				summaryRow.innerHTML = options.summaryCells(job);
				tbody.appendChild(summaryRow);

				let outputRow = rowFor(tbody, key, 'output');
				if (job.session_output) {
					if (!outputRow) {
						outputRow = createSessionRow(key, 'output');
						outputRow.innerHTML = '<td colspan="5">' + sessionOutputBlock(options.outputLabel, {
							live: !!options.live,
							key,
						}) + '</td>';
					}
					tbody.appendChild(outputRow);
					const output = outputRow.querySelector('.session-output');
					if (output) {
						updateSessionOutput(output, job.session_output);
					}
				} else if (outputRow) {
					outputRow.remove();
				}
			}

			Array.from(tbody.querySelectorAll('tr[data-session-row-key]')).forEach((row) => {
				if (!wanted.has(row.dataset.sessionRowKey)) {
					row.remove();
				}
			});
		}

		function renderActiveJobs(jobs) {
			renderJobTable(fields.activeJobs, jobs, {
				emptyText: 'No active jobs',
				keyPrefix: 'active',
				live: true,
				outputLabel: 'Live Session Output',
				summaryCells: activeSummaryCells,
			});
		}

		function renderRecentFailures(jobs) {
			renderJobTable(fields.recentFailures, jobs, {
				emptyText: 'No recent failures',
				filter: (job) => job.status === 'failed',
				keyPrefix: 'failed',
				outputLabel: 'Session Output',
				summaryCells: failureSummaryCells,
			});
		}

		function renderDetails(details) {
			const rows = [
				['Binary', details.codex_binary],
				['Home', details.codex_home],
				['Auth', details.auth_path],
				['Generated Images', details.generated_images_dir],
				['Version', details.version],
				['Login', details.login_status],
			];
			return rows.map(([label, value]) => '<tr><th>' + escapeHtml(label) + '</th><td><code>' + escapeHtml(value) + '</code></td></tr>').join('');
		}

		function featureState(value) {
			return value ? 'enabled' : 'disabled';
		}

		function featureLabel(value) {
			return value ? 'Yes' : 'No';
		}

		function featurePill(name, value) {
			const state = featureState(value);
			return '<div class="feature-pill ' + state + '">' +
				'<span class="name">' + escapeHtml(name) + '</span>' +
				'<span class="state">' + featureLabel(value) + '</span>' +
			'</div>';
		}

		function renderCapabilities(payload) {
			currentCapabilities = payload || {};
			const codex = currentCapabilities.codex || {};
			const features = currentCapabilities.features || {};
			const video = currentCapabilities.video || {};
			const mediaAnalysis = currentCapabilities.media_analysis || {};
			fields.codexCliVersion.textContent = text(codex.version);
			fields.codexBinary.textContent = text(codex.binary);
			fields.detectedFeatures.innerHTML = [
				featurePill('Structured exec JSON', features.structured_exec_json),
				featurePill('Output schema', features.output_schema),
				featurePill('Image attachments', features.image_attachments),
				featurePill('Codex app server', features.app_server),
				featurePill('Local image generation', features.images),
				featurePill('Media analysis route', mediaAnalysis.enabled),
				featurePill('ffmpeg frame extraction', mediaAnalysis.ffmpeg_available),
				featurePill('OpenAI video route', video.enabled),
				featurePill('Video API configured', video.configured),
			].join('');
			currentStatus.capabilities = currentCapabilities;
			fields.rawStatus.textContent = JSON.stringify(currentStatus, null, 2);
		}

		function captureSessionOutputScrolls() {
			const states = new Map();
			document.querySelectorAll('.session-output[data-session-key]').forEach((output) => {
				const maxScrollTop = Math.max(0, output.scrollHeight - output.clientHeight);
				states.set(output.dataset.sessionKey, {
					atBottom: maxScrollTop - output.scrollTop <= 8,
					scrollTop: output.scrollTop,
				});
			});
			return states;
		}

		function restoreSessionOutputScrolls(scrollStates) {
			document.querySelectorAll('.session-output[data-session-key]').forEach((output) => {
				const state = scrollStates.get(output.dataset.sessionKey);
				const maxScrollTop = Math.max(0, output.scrollHeight - output.clientHeight);
				if (state) {
					output.scrollTop = output.classList.contains('live-session-output') && state.atBottom
						? maxScrollTop
						: Math.min(state.scrollTop, maxScrollTop);
					return;
				}
				if (output.classList.contains('live-session-output')) {
					output.scrollTop = maxScrollTop;
				}
			});
		}

		function queueRestoreSessionOutputScrolls(scrollStates) {
			const restore = () => restoreSessionOutputScrolls(scrollStates);
			if (typeof requestAnimationFrame === 'function') {
				requestAnimationFrame(restore);
				return;
			}
			setTimeout(restore, 0);
		}

		async function copyToClipboard(value) {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(value);
				return;
			}
			const textarea = document.createElement('textarea');
			textarea.value = value;
			textarea.setAttribute('readonly', '');
			textarea.style.position = 'fixed';
			textarea.style.left = '-9999px';
			document.body.appendChild(textarea);
			textarea.select();
			document.execCommand('copy');
			textarea.remove();
		}

		document.addEventListener('click', async (event) => {
			const button = event.target.closest('.copy-session-output');
			if (!button) {
				return;
			}
			const block = button.closest('.session-output-block');
			const output = block ? block.querySelector('.session-output') : null;
			if (!output) {
				return;
			}
			const original = button.textContent;
			try {
				await copyToClipboard(output.textContent || '');
				button.textContent = 'Copied';
			} catch (error) {
				button.textContent = 'Copy failed';
			}
			setTimeout(() => {
				button.textContent = original;
			}, 1800);
		});

		function renderJobs(jobs) {
			const scrollStates = captureSessionOutputScrolls();
			fields.jobCounts.textContent = 'Running ' + Number(jobs.running_count || 0) + ' / Queued ' + Number(jobs.queued_count || 0);
			fields.maxConcurrent.textContent = text(jobs.max_concurrent);
			renderActiveJobs(Array.isArray(jobs.active) ? jobs.active : []);
			renderRecentFailures(Array.isArray(jobs.recent) ? jobs.recent : []);
			currentStatus.jobs = jobs;
			fields.rawStatus.textContent = JSON.stringify(currentStatus, null, 2);
			fields.updated.textContent = 'Live updates on - updated ' + new Date().toLocaleTimeString();
			queueRestoreSessionOutputScrolls(scrollStates);
		}

		function renderStatus(payload, ok) {
			currentStatus = payload;
			if (Object.keys(currentCapabilities).length) {
				currentStatus.capabilities = currentCapabilities;
			}
			const jobs = payload.jobs || {};
			const bridge = payload.bridge || {};
			const details = payload.details || {};
			const paired = Array.isArray(bridge.paired_origins) ? bridge.paired_origins : [];
			setPill(fields.bridgePill, ok ? 'ok' : 'bad', ok ? 'Reachable' : 'Error');
			setPill(fields.codexPill, payload.success ? 'ok' : 'warn', payload.success ? 'Ready' : 'Needs attention');
			fields.version.textContent = text(bridge.version);
			fields.pairedSites.innerHTML = paired.length ? paired.map((origin) => '<code>' + escapeHtml(origin) + '</code>').join(' ') : '<span class="muted">None</span>';
			fields.codexDetails.innerHTML = renderDetails(details);
			if (!Object.keys(currentCapabilities).length) {
				fields.codexCliVersion.textContent = text(details.version);
				fields.codexBinary.textContent = text(details.codex_binary);
				fields.detectedFeatures.innerHTML = '<div class="muted">Loading detected features</div>';
			}
			renderJobs(jobs);
		}

		async function refresh() {
			try {
				const [response, capabilitiesResponse] = await Promise.all([
					fetch(statusUrl, { cache: 'no-store' }),
					fetch(capabilitiesUrl, { cache: 'no-store' }).catch(() => null),
				]);
				const payload = await response.json();
				renderStatus(payload, response.ok);
				if (capabilitiesResponse && capabilitiesResponse.ok) {
					renderCapabilities(await capabilitiesResponse.json());
				}
			} catch (error) {
				renderStatus({ success: false, message: error.message, jobs: {} }, false);
			}
		}

		function startFallbackPolling() {
			if (fallbackPollTimer) {
				return;
			}
			fields.updated.textContent = 'Live updates unavailable - polling';
			fallbackPollTimer = setInterval(refresh, 5000);
		}

		function connectJobEvents() {
			if (!window.EventSource) {
				startFallbackPolling();
				return;
			}
			jobEvents = new EventSource(jobEventsUrl);
			jobEvents.addEventListener('jobs', (event) => {
				try {
					renderJobs(JSON.parse(event.data || '{}'));
				} catch (error) {}
			});
			jobEvents.onerror = () => {
				if (jobEvents) {
					jobEvents.close();
					jobEvents = null;
				}
				startFallbackPolling();
			};
		}

		refresh().then(connectJobEvents).catch(() => {
			startFallbackPolling();
		});
	</script>
</body>
</html>`;
}

module.exports = {
	statusPageHtml,
};
