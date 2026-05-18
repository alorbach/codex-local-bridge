'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const assetsDir = path.join(root, 'assets');

function crc32(buffer) {
	let crc = -1;
	for (let i = 0; i < buffer.length; i += 1) {
		crc ^= buffer[i];
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
		}
	}
	return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
	const typeBuffer = Buffer.from(type, 'ascii');
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
	return Buffer.concat([length, typeBuffer, data, crc]);
}

function blend(left, right, amount) {
	return Math.round(left + (right - left) * amount);
}

function blendColor(left, right, amount) {
	return left.map((value, index) => blend(value, right[index], amount));
}

const defaultPalette = {
	top: [88, 240, 255],
	mid: [91, 124, 255],
	bottom: [180, 92, 255],
};

const statePalettes = {
	active: {
		top: [65, 245, 171],
		mid: [39, 174, 255],
		bottom: [56, 121, 255],
	},
	queued: {
		top: [255, 219, 92],
		mid: [255, 160, 67],
		bottom: [247, 107, 28],
	},
	error: {
		top: [255, 116, 116],
		mid: [239, 68, 68],
		bottom: [168, 29, 29],
	},
	stopped: {
		top: [190, 198, 210],
		mid: [107, 119, 140],
		bottom: [58, 68, 84],
	},
};

function activeFramePalette(frameIndex, frameCount) {
	const phase = frameCount > 1 ? frameIndex / (frameCount - 1) : 0;
	const wave = (1 - Math.cos(phase * Math.PI * 2)) / 2;
	const highlight = [232, 255, 255];
	return {
		top: blendColor(statePalettes.active.top, highlight, 0.18 + wave * 0.28),
		mid: blendColor(statePalettes.active.mid, [107, 255, 214], 0.08 + wave * 0.22),
		bottom: blendColor(statePalettes.active.bottom, [92, 184, 255], 0.04 + wave * 0.18),
		phase,
	};
}

function colorFor(size, x, y, palette = defaultPalette) {
	const center = (size - 1) / 2;
	const dx = x - center;
	const dy = y - center;
	const distance = Math.sqrt(dx * dx + dy * dy) / center;
	if (distance > 1) {
		return [0, 0, 0, 0];
	}

	const top = palette.top;
	const mid = palette.mid;
	const bottom = palette.bottom;
	const t = Math.min(1, Math.max(0, (x + y) / (2 * size)));
	const base = t < 0.55
		? top.map((value, index) => blend(value, mid[index], t / 0.55))
		: mid.map((value, index) => blend(value, bottom[index], (t - 0.55) / 0.45));

	const ring = Math.abs(distance - 0.72) < 0.12;
	const bridge = Math.abs(y - (center + Math.sin((x / size) * Math.PI) * 4)) < size * 0.07 && x > size * 0.18 && x < size * 0.82;
	const mast = Math.abs(x - center) < size * 0.055 && y > size * 0.18 && y < size * 0.78;
	const deck = Math.abs(y - size * 0.68) < size * 0.055 && x > size * 0.25 && x < size * 0.75;
	const node = [[0.25, 0.72], [0.75, 0.72], [0.5, 0.25]].some(([nx, ny]) => {
		const ndx = x - size * nx;
		const ndy = y - size * ny;
		return Math.sqrt(ndx * ndx + ndy * ndy) < size * 0.095;
	});
	const hasPulse = Number.isFinite(palette.phase);
	const pulseCenterX = size * (0.2 + (hasPulse ? palette.phase : 0) * 0.6);
	const pulseCenterY = size * 0.42;
	const pulseDistance = Math.sqrt((x - pulseCenterX) ** 2 + (y - pulseCenterY) ** 2) / size;
	const pulse = hasPulse ? Math.max(0, 1 - pulseDistance * 5.2) : 0;
	const pulseBase = [
		blend(base[0], 245, pulse * 0.6),
		blend(base[1], 255, pulse * 0.45),
		blend(base[2], 255, pulse * 0.4),
	];

	if (mast || deck) {
		return [blend(234, 255, pulse * 0.45), blend(252, 255, pulse * 0.35), 255, 255];
	}
	if (bridge || node) {
		return [pulseBase[0], pulseBase[1], pulseBase[2], 255];
	}
	if (ring) {
		return [pulseBase[0], pulseBase[1], pulseBase[2], 235];
	}
	const shade = 1 - distance * 0.32;
	return [Math.round(8 * shade), Math.round(24 * shade), Math.round(39 * shade), 245];
}

function createPng(size, palette) {
	const rows = [];
	for (let y = 0; y < size; y += 1) {
		const row = Buffer.alloc(1 + size * 4);
		row[0] = 0;
		for (let x = 0; x < size; x += 1) {
			const [r, g, b, a] = colorFor(size, x, y, palette);
			const offset = 1 + x * 4;
			row[offset] = r;
			row[offset + 1] = g;
			row[offset + 2] = b;
			row[offset + 3] = a;
		}
		rows.push(row);
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function createIco(images) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);

	const entries = [];
	let offset = 6 + images.length * 16;
	for (const image of images) {
		const entry = Buffer.alloc(16);
		entry[0] = image.size >= 256 ? 0 : image.size;
		entry[1] = image.size >= 256 ? 0 : image.size;
		entry[2] = 0;
		entry[3] = 0;
		entry.writeUInt16LE(1, 4);
		entry.writeUInt16LE(32, 6);
		entry.writeUInt32LE(image.data.length, 8);
		entry.writeUInt32LE(offset, 12);
		entries.push(entry);
		offset += image.data.length;
	}
	return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

fs.mkdirSync(assetsDir, { recursive: true });
const pngs = [16, 32, 64, 256].map((size) => ({ size, data: createPng(size) }));
for (const image of pngs) {
	fs.writeFileSync(path.join(assetsDir, `icon-${image.size}.png`), image.data);
}
fs.writeFileSync(path.join(assetsDir, 'tray-icon.png'), pngs.find((image) => image.size === 32).data);
for (const [name, palette] of Object.entries(statePalettes)) {
	fs.writeFileSync(path.join(assetsDir, `tray-${name}.png`), createPng(32, palette));
}
for (let frame = 0; frame < 6; frame += 1) {
	fs.writeFileSync(path.join(assetsDir, `tray-active-${frame}.png`), createPng(32, activeFramePalette(frame, 6)));
}
fs.writeFileSync(path.join(assetsDir, 'icon.ico'), createIco(pngs));
process.stdout.write('Generated Local Codex bridge icons.\n');
