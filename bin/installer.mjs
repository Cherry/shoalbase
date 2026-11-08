// Helpers of the `npx shoalbase` installer, kept apart from the script so they can be tested.

/** The git ref to clone: this package's release tag, or the default branch for an unreleased checkout. */
export function releaseRef(packageVersion) {
	if (/^\d+\.\d+\.\d+$/.test(packageVersion)) {
		return `v${packageVersion}`;
	}
}

/** Turns one server's answers into a PMA_SERVERS entry, leaving out defaults so the JSON stays short. */
export function serverEntry({ host, port, ssl, pin }) {
	const entry = { host };
	if (port !== 3306) {
		entry.port = port;
	}
	if (ssl) {
		entry.ssl = true;
	}
	if (pin) {
		entry.pin = pin;
	}
	return entry;
}
