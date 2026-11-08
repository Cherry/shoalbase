// strtotime() and date() for the MySQL DATE, TIME and DATETIME strings ExportOds converts, in the image's UTC zone.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;
const TIME = /^(-?)(\d{2,3}):(\d{2}):(\d{2})(?:\.\d+)?$/;

// gmmktime(): out of range days and months roll over, and years 0-99 are not shifted to 19xx.
function utcSeconds(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0): number {
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(hours, minutes, seconds, 0);
	return date.getTime() / 1000;
}

/** strtotime() of a MySQL temporal value, or null where PHP returns false; `now` is time() in seconds. */
export function mysqlStrtotime(value: string, now: number): number | null {
	const dateTime = DATETIME.exec(value) ?? DATE.exec(value);
	if (dateTime !== null) {
		const [year, month, day, hours = 0, minutes = 0, seconds = 0] = dateTime.slice(1).map(Number);
		if (month > 12 || day > 31 || hours > 24 || minutes > 59 || seconds > 60) {
			return null;
		}
		return utcSeconds(year, month, day, hours, minutes, seconds);
	}
	const time = TIME.exec(value);
	if (time === null) {
		return null;
	}
	const [hours, minutes, seconds] = time.slice(2).map(Number);
	if (hours > 24 || minutes > 59 || seconds > 60) {
		return null;
	}
	const offset = (hours * 3600) + (minutes * 60) + seconds;
	// A leading minus makes timelib read the value as a UTC offset applied to the current time.
	if (time[1] === '-') {
		return now + offset;
	}
	return (Math.floor(now / 86400) * 86400) + offset;
}

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

/** date() for the Y, m, d, H, i and s conversions; a backslash keeps the next character. */
export function phpDate(format: string, timestamp: number): string {
	const date = new Date(timestamp * 1000);
	const year = date.getUTCFullYear();
	const conversions: Record<string, string> = {
		Y: year < 0 ? `-${pad(-year, 4)}` : pad(year, 4),
		m: pad(date.getUTCMonth() + 1),
		d: pad(date.getUTCDate()),
		H: pad(date.getUTCHours()),
		i: pad(date.getUTCMinutes()),
		s: pad(date.getUTCSeconds()),
	};
	return format.replaceAll(/\\(.)|(.)/gs, (_, escaped: string | undefined, character: string) => escaped ?? conversions[character] ?? character);
}
