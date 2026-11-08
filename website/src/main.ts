// Copy buttons and the contour chart behind the hero. `npm run build` in website/ strips the types into public/main.js.

type Point = [number, number];
type Noise = (x: number, y: number) => number;

for (const button of document.querySelectorAll<HTMLElement>('[data-copy-target]')) {
	button.addEventListener('click', async () => {
		const code = document.querySelector(`#${button.dataset.copyTarget}`);
		if (!code) {
			return;
		}
		try {
			await navigator.clipboard.writeText(code.textContent ?? '');
			button.textContent = 'Copied';
		} catch {
			// Without clipboard access, select the command so it can be copied by hand.
			getSelection()?.selectAllChildren(code);
			button.textContent = 'Selected';
		}
		setTimeout(() => {
			button.textContent = 'Copy';
		}, 1600);
	});
}

// A seeded generator, so the chart looks the same on every visit.
function mulberry32(seed: number) {
	let state = seed;
	return () => {
		state = (state + 0x6D_2B_79_F5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function makeNoise(random: () => number): Noise {
	const size = 64;
	const lattice = Float32Array.from({ length: size * size }, () => random());
	const smooth = (progress: number) => progress * progress * (3 - (2 * progress));
	const at = (x: number, y: number) => lattice[((y % size) * size) + (x % size)];
	return (x, y) => {
		const x0 = Math.floor(x);
		const y0 = Math.floor(y);
		const sx = smooth(x - x0);
		const sy = smooth(y - y0);
		const top = at(x0, y0) + ((at(x0 + 1, y0) - at(x0, y0)) * sx);
		const bottom = at(x0, y0 + 1) + ((at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx);
		return top + ((bottom - top) * sy);
	};
}

function depthField(noise: Noise, x: number, y: number) {
	let total = 0;
	let amplitude = 0.55;
	let frequency = 1;
	for (let octave = 0; octave < 4; octave++) {
		total += noise((x * frequency) + 7, (y * frequency) + 3) * amplitude;
		amplitude *= 0.5;
		frequency *= 2.03;
	}
	return total;
}

// Marching squares: for each cell, the edges where the field crosses the level, joined into short segments.
function contourSegments(grid: Float32Array, columns: number, rows: number, cell: number, level: number) {
	const segments: Point[] = [];
	const lerp = (from: number, to: number) => (level - from) / (to - from);
	for (let row = 0; row < rows - 1; row++) {
		for (let column = 0; column < columns - 1; column++) {
			const topLeft = grid[(row * columns) + column];
			const topRight = grid[(row * columns) + column + 1];
			const bottomRight = grid[((row + 1) * columns) + column + 1];
			const bottomLeft = grid[((row + 1) * columns) + column];
			const x = column * cell;
			const y = row * cell;
			const crossings: Point[] = [];
			if ((topLeft < level) !== (topRight < level)) {
				crossings.push([x + (lerp(topLeft, topRight) * cell), y]);
			}
			if ((topRight < level) !== (bottomRight < level)) {
				crossings.push([x + cell, y + (lerp(topRight, bottomRight) * cell)]);
			}
			if ((bottomLeft < level) !== (bottomRight < level)) {
				crossings.push([x + (lerp(bottomLeft, bottomRight) * cell), y + cell]);
			}
			if ((topLeft < level) !== (bottomLeft < level)) {
				crossings.push([x, y + (lerp(topLeft, bottomLeft) * cell)]);
			}
			for (let index = 0; index + 1 < crossings.length; index += 2) {
				segments.push(crossings[index], crossings[index + 1]);
			}
		}
	}
	return segments;
}

function drawChart(canvas: HTMLCanvasElement) {
	const ratio = Math.min(window.devicePixelRatio || 1, 2);
	const { width, height } = canvas.getBoundingClientRect();
	canvas.width = Math.round(width * ratio);
	canvas.height = Math.round(height * ratio);
	const context = canvas.getContext('2d');
	if (!context) {
		return;
	}
	context.scale(ratio, ratio);

	const styles = getComputedStyle(document.documentElement);
	const contour = styles.getPropertyValue('--contour').trim();
	const soundingColor = styles.getPropertyValue('--ink-soft').trim();
	const random = mulberry32(20_261_108);
	const noise = makeNoise(random);
	const cell = 12;
	const columns = Math.ceil(width / cell) + 1;
	const rows = Math.ceil(height / cell) + 1;
	const scale = 1 / 260;
	const grid = new Float32Array(columns * rows);
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			grid[(row * columns) + column] = depthField(noise, column * cell * scale, row * cell * scale);
		}
	}

	context.strokeStyle = contour;
	context.lineCap = 'round';
	for (let level = 0.3; level <= 0.8; level += 0.045) {
		// Every fourth contour is drawn heavier, as charts do for their index lines.
		const index = Math.round((level - 0.3) / 0.045);
		context.lineWidth = index % 4 === 0 ? 1.6 : 0.8;
		const segments = contourSegments(grid, columns, rows, cell, level);
		context.beginPath();
		for (let point = 0; point < segments.length; point += 2) {
			context.moveTo(...segments[point]);
			context.lineTo(...segments[point + 1]);
		}
		context.stroke();
	}

	// A few soundings, in fathoms, where the field is deepest.
	context.fillStyle = soundingColor;
	context.globalAlpha = 0.55;
	context.font = '11px "Chivo Mono", Consolas, monospace';
	for (let placed = 0; placed < 14; placed++) {
		const x = random() * width;
		const y = random() * height;
		const depth = depthField(noise, x * scale, y * scale);
		context.fillText(String(Math.max(1, Math.round((1 - depth) * 24))), x, y);
	}
	context.globalAlpha = 1;
}

const canvas = document.querySelector<HTMLCanvasElement>('.chart');
if (canvas) {
	const redraw = () => drawChart(canvas);
	let pending = 0;
	const schedule = () => {
		cancelAnimationFrame(pending);
		pending = requestAnimationFrame(redraw);
	};
	document.fonts.ready.then(redraw);
	new ResizeObserver(schedule).observe(canvas);
	matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule);
}

// Respect reduced motion for the looping hero video.
const heroVideo = document.querySelector<HTMLVideoElement>('.hero-video video');
if (heroVideo && matchMedia('(prefers-reduced-motion: reduce)').matches) {
	heroVideo.removeAttribute('autoplay');
	heroVideo.controls = true;
	heroVideo.pause();
}
