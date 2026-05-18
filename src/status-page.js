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
		const fields = {
			updated: document.getElementById('updated'),
			bridgePill: document.getElementById('bridgePill'),
			codexPill: document.getElementById('codexPill'),
			jobCounts: document.getElementById('jobCounts'),
			version: document.getElementById('version'),
			maxConcurrent: document.getElementById('maxConcurrent'),
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

		function renderRows(jobs) {
			if (!jobs.length) {
				return '<tr><td colspan="5" class="muted">No active jobs</td></tr>';
			}
			return jobs.map((job) => {
				const summary = '<tr>' +
					'<td><code>' + escapeHtml(job.short_request_id || job.request_id || job.id) + '</code></td>' +
					'<td>' + escapeHtml(job.type) + '</td>' +
					'<td>' + escapeHtml(job.model) + '</td>' +
					'<td>' + escapeHtml(job.status) + '</td>' +
					'<td>' + elapsed(job.elapsed_ms) + '</td>' +
				'</tr>';
				if (!job.session_output) {
					return summary;
				}
				return summary + '<tr><td colspan="5"><div class="label">Live Session Output</div><pre class="session-output live-session-output">' + escapeHtml(job.session_output) + '</pre></td></tr>';
			}).join('');
		}

		function renderFailures(jobs) {
			const failures = jobs.filter((job) => job.status === 'failed');
			if (!failures.length) {
				return '<tr><td colspan="5" class="muted">No recent failures</td></tr>';
			}
			return failures.map((job) => {
				const summary = '<tr>' +
					'<td><code>' + escapeHtml(job.short_request_id || job.request_id || job.id) + '</code></td>' +
					'<td>' + escapeHtml(job.type) + '</td>' +
					'<td>' + escapeHtml(job.model) + '</td>' +
					'<td>' + escapeHtml(job.error_message || 'Request failed') + '</td>' +
					'<td>' + (job.finished_at ? new Date(job.finished_at).toLocaleTimeString() : '-') + '</td>' +
				'</tr>';
				if (!job.session_output) {
					return summary;
				}
				return summary + '<tr><td colspan="5"><div class="label">Session Output</div><pre class="session-output">' + escapeHtml(job.session_output) + '</pre></td></tr>';
			}).join('');
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

		function followLiveSessionOutput() {
			fields.activeJobs.querySelectorAll('.live-session-output').forEach((output) => {
				output.scrollTop = output.scrollHeight;
			});
		}

		function queueFollowLiveSessionOutput() {
			if (typeof requestAnimationFrame === 'function') {
				requestAnimationFrame(followLiveSessionOutput);
				return;
			}
			setTimeout(followLiveSessionOutput, 0);
		}

		function renderStatus(payload, ok) {
			const jobs = payload.jobs || {};
			const bridge = payload.bridge || {};
			const details = payload.details || {};
			const paired = Array.isArray(bridge.paired_origins) ? bridge.paired_origins : [];
			setPill(fields.bridgePill, ok ? 'ok' : 'bad', ok ? 'Reachable' : 'Error');
			setPill(fields.codexPill, payload.success ? 'ok' : 'warn', payload.success ? 'Ready' : 'Needs attention');
			fields.jobCounts.textContent = 'Running ' + Number(jobs.running_count || 0) + ' / Queued ' + Number(jobs.queued_count || 0);
			fields.version.textContent = text(bridge.version);
			fields.maxConcurrent.textContent = text(jobs.max_concurrent);
			fields.activeJobs.innerHTML = renderRows(Array.isArray(jobs.active) ? jobs.active : []);
			fields.recentFailures.innerHTML = renderFailures(Array.isArray(jobs.recent) ? jobs.recent : []);
			fields.pairedSites.innerHTML = paired.length ? paired.map((origin) => '<code>' + escapeHtml(origin) + '</code>').join(' ') : '<span class="muted">None</span>';
			fields.codexDetails.innerHTML = renderDetails(details);
			fields.rawStatus.textContent = JSON.stringify(payload, null, 2);
			fields.updated.textContent = 'Auto-refresh on - updated ' + new Date().toLocaleTimeString();
			queueFollowLiveSessionOutput();
		}

		async function refresh() {
			try {
				const response = await fetch(statusUrl, { cache: 'no-store' });
				const payload = await response.json();
				renderStatus(payload, response.ok);
			} catch (error) {
				renderStatus({ success: false, message: error.message, jobs: {} }, false);
			}
		}

		refresh();
		setInterval(refresh, 2000);
	</script>
</body>
</html>`;
}

module.exports = {
	statusPageHtml,
};
