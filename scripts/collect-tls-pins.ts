// Prints the SHA-256 SPKI pin of each MySQL server's TLS certificate, for the `pin` fields of PMA_SERVERS.
// Usage: node scripts/collect-tls-pins.ts host[:port] ...
// Only MySQL needs pins: MariaDB regenerates its zero-config certificate on restart and is verified with its password proof instead.
import process from 'node:process';

import { pinFor } from '../bin/installer.ts';

for (const target of process.argv.slice(2)) {
	const [host, port = '3306'] = target.split(':', 2);
	try {
		const { version, pin, subject, validTo } = await pinFor(host, Number(port));
		console.log(`${host}\t${version}\t${pin}\t${subject.replaceAll('\n', ' ')}\tvalid to ${validTo}`);
	} catch (error) {
		console.log(`${host}\tERROR ${error instanceof Error ? error.message : String(error)}`);
	}
}
