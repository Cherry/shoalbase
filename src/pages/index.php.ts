import type { APIRoute } from 'astro';

import { dispatch } from '~/server/pma/dispatcher';

export const ALL: APIRoute = context => dispatch(context);
