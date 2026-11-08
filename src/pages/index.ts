import type { APIRoute } from 'astro';

import { dispatch } from '~/server/pma/dispatcher';

// Apache's DirectoryIndex serves index.php for the docroot itself.
export const ALL: APIRoute = context => dispatch(context);
