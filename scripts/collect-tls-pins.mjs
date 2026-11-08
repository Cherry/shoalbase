// Prints the SHA-256 SPKI pin of each MySQL server's TLS certificate, for the `pin` fields of PMA_SERVERS.
// Usage: node scripts/collect-tls-pins.mjs host[:port] ...
// Only MySQL needs pins: MariaDB regenerates its zero-config certificate on restart and is verified with its password proof instead.
import { X509Certificate, createHash } from 'node:crypto';
import net from 'node:net';
import process from 'node:process';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

const SSL_REQUEST_CAPABILITIES = 0x1 | 0x2_00 | 0x8_00 | 0x80_00 | 0x8_00_00;

export const pinFor = (host, port) => new Promise((resolve, reject) => {
	const plain = net.connect({ host, port, timeout: 8000 });
	plain.once('timeout', () => plain.destroy(new Error('timed out')));
	plain.once('error', reject);
	plain.once('data', (greeting) => {
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

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
for (const target of isMain ? process.argv.slice(2) : []) {
	const [host, port = '3306'] = target.split(':', 2);
	try {
		const { version, pin, subject, validTo } = await pinFor(host, Number(port));
		console.log(`${host}\t${version}\t${pin}\t${subject.replaceAll('\n', ' ')}\tvalid to ${validTo}`);
	} catch (error) {
		console.log(`${host}\tERROR ${error.message}`);
	}
}
