// Node stand-in for cloudflare:sockets, so render-route can run the Worker connector (and its in-process TLS) against local TLS servers.
import { once } from 'node:events';
import { connect as netConnect } from 'node:net';
import { Duplex } from 'node:stream';

interface SocketAddress {
	hostname: string;
	port: number;
}

export function connect(address: SocketAddress) {
	const socket = netConnect({ host: address.hostname, port: address.port });
	const { readable, writable } = Duplex.toWeb(socket);
	return {
		readable: readable as ReadableStream<Uint8Array>,
		writable: writable as WritableStream<Uint8Array>,
		opened: once(socket, 'connect').then(() => { return {}; }),
		closed: once(socket, 'close').then(() => {}),
		close: async () => {
			socket.destroy();
		},
	};
}
