// PHP casts and checks that request handling in the server controllers relies on.
export { phpToFloat as phpFloat, phpToInt as phpInt } from '../sprintf.ts';

/** PHP's empty() for a request value. */
export function phpEmpty(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.length === 0;
	}
	return [undefined, null, '', '0', false, 0].includes(value as never);
}
