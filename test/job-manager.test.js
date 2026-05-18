'use strict';

const assert = require('assert');
const { JobManager } = require('../src/job-manager');

function tick() {
	return new Promise((resolve) => setImmediate(resolve));
}

function deferredRunner(label, started, resolvers, result = { success: true }) {
	return () => new Promise((resolve) => {
		started.push(label);
		resolvers[label] = () => resolve({ ...result, label });
	});
}

(async () => {
	{
		const started = [];
		const resolvers = {};
		const manager = new JobManager({ maxConcurrent: 2 });
		const first = manager.run({ requestId: 'request-1', type: 'chat', model: 'codex-local:auto' }, deferredRunner('first', started, resolvers));
		const second = manager.run({ requestId: 'request-2', type: 'chat', model: 'codex-local:auto' }, deferredRunner('second', started, resolvers));
		const third = manager.run({ requestId: 'request-3', type: 'chat', model: 'codex-local:auto' }, deferredRunner('third', started, resolvers));
		await tick();
		assert.deepStrictEqual(started, ['first', 'second']);
		assert.strictEqual(manager.snapshot().running_count, 2);
		assert.strictEqual(manager.snapshot().queued_count, 1);

		resolvers.second();
		assert.strictEqual((await second).label, 'second');
		await tick();
		assert.deepStrictEqual(started, ['first', 'second', 'third']);

		resolvers.first();
		resolvers.third();
		await Promise.all([first, third]);
		assert.strictEqual(manager.snapshot().running_count, 0);
		assert.strictEqual(manager.snapshot().queued_count, 0);
	}

	{
		const manager = new JobManager({ maxConcurrent: 1 });
		const failed = await manager.run({ requestId: 'request-fail', type: 'chat' }, () => ({ success: false, message: 'failed' }));
		assert.strictEqual(failed.success, false);
		assert.strictEqual(manager.snapshot().recent[0].status, 'failed');
		const next = await manager.run({ requestId: 'request-next', type: 'chat' }, () => ({ success: true }));
		assert.strictEqual(next.success, true);
	}

	{
		const started = [];
		const resolvers = {};
		const manager = new JobManager({ maxConcurrent: 2 });
		const chatOne = manager.run({ requestId: 'chat-1', type: 'chat' }, deferredRunner('chat-one', started, resolvers));
		const image = manager.run({ requestId: 'image-1', type: 'images' }, deferredRunner('image', started, resolvers));
		const chatTwo = manager.run({ requestId: 'chat-2', type: 'chat' }, deferredRunner('chat-two', started, resolvers));
		await tick();
		assert.deepStrictEqual(started, ['chat-one', 'chat-two']);
		assert.strictEqual(manager.snapshot().queued_count, 1);

		resolvers['chat-one']();
		resolvers['chat-two']();
		await Promise.all([chatOne, chatTwo]);
		await tick();
		assert.deepStrictEqual(started, ['chat-one', 'chat-two', 'image']);
		assert.strictEqual(manager.snapshot().running_count, 1);
		resolvers.image();
		await image;
		assert.strictEqual(manager.snapshot().running_count, 0);
	}

	console.log('job manager tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
