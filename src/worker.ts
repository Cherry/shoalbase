// The Worker entry: Astro renders every request, and the session Durable Object class is exported for the PMA_SESSIONS binding.
import { handle } from '@astrojs/cloudflare/handler';

export { PmaSessionObject } from '~/server/session-object';

export default {
	fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
		return handle(request, env, context);
	},
};
