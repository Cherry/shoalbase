import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

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

/** Copies an image onto a larger canvas filled with a checker so size differences stay visible in the diff. */
function pad(image: PNG, width: number, height: number): PNG {
	const out = new PNG({ width, height });
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
	PNG.bitblt(image, out, 0, 0, image.width, image.height, 0, 0);
	return out;
}

/** Pixel-diffs ours against the oracle and writes oracle.png, ours.png, diff.png and side-by-side.png for the screen. */
export function compareScreens(screen: string, oracleBuffer: Buffer, oursBuffer: Buffer): DiffResult {
	const dir = path.join(REPORT_DIR, screen);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, 'oracle.png'), oracleBuffer);
	writeFileSync(path.join(dir, 'ours.png'), oursBuffer);

	const oracle = PNG.sync.read(oracleBuffer);
	const ours = PNG.sync.read(oursBuffer);
	const width = Math.max(oracle.width, ours.width);
	const height = Math.max(oracle.height, ours.height);
	const left = pad(oracle, width, height);
	const right = pad(ours, width, height);
	const diff = new PNG({ width, height });
	const diffPixels = pixelmatch(left.data, right.data, diff.data, width, height, { threshold: 0.1, includeAA: false });
	writeFileSync(path.join(dir, 'diff.png'), PNG.sync.write(diff));

	const gap = 8;
	const combined = new PNG({ width: width * 3 + gap * 2, height });
	combined.data.fill(255);
	PNG.bitblt(left, combined, 0, 0, width, height, 0, 0);
	PNG.bitblt(right, combined, 0, 0, width, height, width + gap, 0);
	PNG.bitblt(diff, combined, 0, 0, width, height, (width + gap) * 2, 0);
	const sideBySide = path.join(dir, 'side-by-side.png');
	writeFileSync(sideBySide, PNG.sync.write(combined));

	return {
		screen,
		oracleSize: `${oracle.width}x${oracle.height}`,
		oursSize: `${ours.width}x${ours.height}`,
		diffPixels,
		diffRatio: diffPixels / (width * height),
		sideBySide: path.relative(path.join(import.meta.dirname, '..', '..', '..'), sideBySide).replaceAll('\\', '/'),
	};
}
