// Helpers of the `npx shoalbase` installer, kept apart from the script so they can be tested and shared with scripts/collect-tls-pins.ts.
import { X509Certificate, createHash } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

/** One PMA_SERVERS entry, as the Worker reads it. */
export interface ServerEntry {
	host: string;
	port?: number;
	ssl?: boolean;
	pin?: string;
}

/** What a MySQL server presents over TLS, with the pin of its certificate's key. */
export interface PresentedCertificate {
	version: string;
	pin: string;
	subject: string;
	validTo: string;
}

const SSL_REQUEST_CAPABILITIES = 0x1 | 0x2_00 | 0x8_00 | 0x80_00 | 0x8_00_00;

/** The git ref to clone: this package's release tag, or the default branch for an unreleased checkout. */
export function releaseRef(packageVersion: string): string | undefined {
	if (/^\d+\.\d+\.\d+$/.test(packageVersion)) {
		return `v${packageVersion}`;
	}
}

/** Turns one server's answers into a PMA_SERVERS entry, leaving out defaults so the JSON stays short. */
export function serverEntry({ host, port, ssl, pin }: { host: string; port: number; ssl: boolean; pin?: string; }): ServerEntry {
	const entry: ServerEntry = { host };
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

/** Upgrades a MySQL connection to TLS and returns the base64 SHA-256 SPKI pin of the certificate it presents. */
export function pinFor(host: string, port: number): Promise<PresentedCertificate> {
	return new Promise((resolve, reject) => {
		const plain = net.connect({ host, port, timeout: 8000 });
		plain.once('timeout', () => plain.destroy(new Error('timed out')));
		plain.once('error', reject);
		plain.once('data', (greeting: Buffer) => {
			const version = greeting.subarray(5, greeting.indexOf(0, 5)).toString();
			const request = Buffer.alloc(36);
			request.writeUIntLE(32, 0, 3);
			request[3] = 1;
			request.writeUInt32LE(SSL_REQUEST_CAPABILITIES, 4);
			request.writeUInt32LE(16_777_216, 8);
			request[12] = 45;
			plain.write(request);
			// Verification is intentionally off: this records whatever key the server presents so it can be reviewed and pinned.
			const secure = tls.connect({ socket: plain, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host });
			secure.once('error', reject);
			secure.once('secureConnect', () => {
				const certificate = new X509Certificate(secure.getPeerCertificate().raw);
				const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
				resolve({ version, pin: createHash('sha256').update(spki).digest('base64'), subject: certificate.subject, validTo: certificate.validTo });
				secure.destroy();
			});
		});
	});
}
