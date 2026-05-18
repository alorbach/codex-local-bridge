'use strict';

function clampMaxConcurrent(value) {
	const parsed = Number.parseInt(String(value || ''), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

function shortRequestId(value) {
	const text = String(value || '').trim();
	return text.length > 18 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text;
}

function truncateOutput(value, maxLength = 12000) {
	const text = String(value || '').trim();
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, 6000)}\n\n...[truncated ${text.length - maxLength} chars]...\n\n${text.slice(-6000)}`;
}

function collectSessionOutput(failure) {
	const details = failure && failure.details && typeof failure.details === 'object' ? failure.details : {};
	const sections = [];
	for (const key of ['error', 'stderr', 'stdout', 'response_text', 'generated_images_dir']) {
		const value = details[key];
		if (value) {
			sections.push(`${key.toUpperCase()}:\n${String(value).trim()}`);
		}
	}
	if (!sections.length && failure && failure.error && failure.error.message) {
		sections.push(`ERROR:\n${failure.error.message}`);
	}
	return truncateOutput(sections.join('\n\n'));
}

class JobManager {
	constructor(options = {}) {
		this.maxConcurrent = clampMaxConcurrent(options.maxConcurrent);
		this.now = typeof options.now === 'function' ? options.now : () => Date.now();
		this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
		this.running = new Map();
		this.queue = [];
		this.recent = [];
		this.nextId = 1;
	}

	run(meta, runner) {
		if (typeof runner !== 'function') {
			return Promise.reject(new Error('A job runner function is required.'));
		}
		const now = this.now();
		const job = {
			id: this.nextId++,
			requestId: String(meta.requestId || ''),
			type: String(meta.type || 'job'),
			model: String(meta.model || ''),
			status: 'queued',
			createdAt: now,
			startedAt: 0,
			finishedAt: 0,
			lastOutputEmitAt: 0,
			sessionOutput: '',
			runner,
		};

		const promise = new Promise((resolve, reject) => {
			job.resolve = resolve;
			job.reject = reject;
		});
		this.queue.push(job);
		this.emitChange();
		this.drain();
		return promise;
	}

	canStart(job) {
		if (this.running.size >= this.maxConcurrent) {
			return false;
		}
		const hasRunningImage = Array.from(this.running.values()).some((runningJob) => runningJob.type === 'images');
		if (job.type === 'images') {
			return this.running.size === 0;
		}
		return !hasRunningImage;
	}

	drain() {
		let started = false;
		do {
			started = false;
			const index = this.queue.findIndex((job) => this.canStart(job));
			if (index === -1) {
				break;
			}
			const [job] = this.queue.splice(index, 1);
			this.start(job);
			started = true;
		} while (started);
	}

	start(job) {
		job.status = 'running';
		job.startedAt = this.now();
		this.running.set(job.id, job);
		this.emitChange();

		Promise.resolve()
			.then(() => job.runner({
				appendSessionOutput: (stream, chunk) => this.appendSessionOutput(job, stream, chunk),
			}))
			.then((result) => {
				this.finish(job, result && result.success === false ? 'failed' : 'completed', result);
				job.resolve(result);
			})
			.catch((error) => {
				this.finish(job, 'failed', error);
				job.reject(error);
			});
	}

	appendSessionOutput(job, stream, chunk) {
		const text = String(chunk || '').trim();
		if (!text) {
			return;
		}
		const label = String(stream || 'output').toUpperCase();
		const next = job.sessionOutput
			? `${job.sessionOutput}\n\n${label}:\n${text}`
			: `${label}:\n${text}`;
		job.sessionOutput = truncateOutput(next);
		const now = this.now();
		if (!job.lastOutputEmitAt || now - job.lastOutputEmitAt >= 500) {
			job.lastOutputEmitAt = now;
			this.emitChange();
		}
	}

	finish(job, status, failure) {
		this.running.delete(job.id);
		job.status = status;
		job.finishedAt = this.now();
		job.errorMessage = failure && failure.message ? String(failure.message) : '';
		if (!job.errorMessage && failure && failure.error && failure.error.message) {
			job.errorMessage = String(failure.error.message);
		}
		if (status === 'failed') {
			const finalOutput = collectSessionOutput(failure);
			if (finalOutput && !job.sessionOutput.includes(finalOutput)) {
				job.sessionOutput = truncateOutput(job.sessionOutput ? `${job.sessionOutput}\n\n${finalOutput}` : finalOutput);
			}
		} else {
			job.sessionOutput = '';
		}
		this.recent.unshift({
			id: job.id,
			requestId: job.requestId,
			type: job.type,
			model: job.model,
			status: job.status,
			startedAt: job.startedAt,
			finishedAt: job.finishedAt,
			errorMessage: job.errorMessage,
			sessionOutput: job.sessionOutput,
		});
		this.recent = this.recent.slice(0, 8);
		this.emitChange();
		this.drain();
	}

	compact(job) {
		const referenceTime = job.finishedAt || this.now();
		const startedAt = job.startedAt || job.createdAt;
		const compacted = {
			id: job.id,
			request_id: job.requestId,
			short_request_id: shortRequestId(job.requestId || String(job.id)),
			type: job.type,
			model: job.model,
			status: job.status,
			started_at: job.startedAt || 0,
			finished_at: job.finishedAt || 0,
			elapsed_ms: Math.max(0, referenceTime - startedAt),
		};
		if (job.errorMessage) {
			compacted.error_message = job.errorMessage;
		}
		if (job.sessionOutput) {
			compacted.session_output = job.sessionOutput;
		}
		return compacted;
	}

	snapshot() {
		return {
			running_count: this.running.size,
			queued_count: this.queue.length,
			max_concurrent: this.maxConcurrent,
			active: Array.from(this.running.values()).map((job) => this.compact(job)),
			queued: this.queue.slice(0, 5).map((job) => this.compact(job)),
			recent: this.recent.slice(0, 5).map((job) => this.compact(job)),
		};
	}

	emitChange() {
		this.onChange(this.snapshot());
	}
}

module.exports = {
	JobManager,
	clampMaxConcurrent,
	collectSessionOutput,
	shortRequestId,
	truncateOutput,
};
