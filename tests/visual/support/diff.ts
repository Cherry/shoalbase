import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import pixelmatch from 'pixelmatch';
import sharp from 'sharp';

export const REPORT_DIR = path.join(import.meta.dirname, '..', 'report');

export interface DiffResult {
	screen: string;
	oracleSize: string;
	oursSize: string;
	diffPixels: number;
	diffRatio: number;
	sideBySide: string;
	note?: string;
}

/** An image as 8-bit RGBA pixels, row by row. */
interface Rgba {
	data: Buffer;
	width: number;
	height: number;
}

const blank = (width: number, height: number): Rgba => {
	return { data: Buffer.alloc(width * height * 4), width, height };
};

async function decode(png: Buffer): Promise<Rgba> {
	const { data, info } = await sharp(png).ensureAlpha().raw()
		.toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height };
}

const encode = (image: Rgba): Promise<Buffer> => sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } }).png().toBuffer();

/** Copies all of `source` into `target` with its top-left corner at column `left`. */
function blit(source: Rgba, target: Rgba, left: number): void {
	const rowBytes = source.width * 4;
	for (let y = 0; y < source.height; y++) {
		source.data.copy(target.data, (y * target.width + left) * 4, y * rowBytes, (y + 1) * rowBytes);
	}
}

/** Copies an image onto a larger canvas filled with a checker so size differences stay visible in the diff. */
function pad(image: Rgba, width: number, height: number): Rgba {
	const out = blank(width, height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const index = (y * width + x) * 4;
			const checker = ((x >> 3) + (y >> 3)) % 2 === 0 ? 255 : 200;
			out.data[index] = checker;
			out.data[index + 1] = checker;
			out.data[index + 2] = checker;
			out.data[index + 3] = 255;
		}
	}
	blit(image, out, 0);
	return out;
}

/** Pixel-diffs ours against the oracle and writes oracle.png, ours.png, diff.png and side-by-side.png for the screen. */
export async function compareScreens(screen: string, oracleBuffer: Buffer, oursBuffer: Buffer): Promise<DiffResult> {
	const dir = path.join(REPORT_DIR, screen);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, 'oracle.png'), oracleBuffer);
	writeFileSync(path.join(dir, 'ours.png'), oursBuffer);

	const oracle = await decode(oracleBuffer);
	const ours = await decode(oursBuffer);
	const width = Math.max(oracle.width, ours.width);
	const height = Math.max(oracle.height, ours.height);
	const left = pad(oracle, width, height);
	const right = pad(ours, width, height);
	const diff = blank(width, height);
	const diffPixels = pixelmatch(left.data, right.data, diff.data, width, height, { threshold: 0.1, includeAA: false });
	writeFileSync(path.join(dir, 'diff.png'), await encode(diff));

	const gap = 8;
	const combined = blank(width * 3 + gap * 2, height);
	combined.data.fill(255);
	blit(left, combined, 0);
	blit(right, combined, width + gap);
	blit(diff, combined, (width + gap) * 2);
	const sideBySide = path.join(dir, 'side-by-side.png');
	writeFileSync(sideBySide, await encode(combined));

	return {
		screen,
		oracleSize: `${oracle.width}x${oracle.height}`,
		oursSize: `${ours.width}x${ours.height}`,
		diffPixels,
		diffRatio: diffPixels / (width * height),
		sideBySide: path.relative(path.join(import.meta.dirname, '..', '..', '..'), sideBySide).replaceAll('\\', '/'),
	};
}
