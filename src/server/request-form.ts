import { type RequestParams, paramsFrom } from '~/lib/pma-request';

/** Parses a form POST body once, since a body can only be read once and both the middleware and the dispatcher need it. */
export async function requestForm(request: Request, locals: App.Locals): Promise<FormData | null> {
	if (locals.form !== undefined) {
		return locals.form;
	}
	let form: FormData | null = null;
	if (request.method === 'POST' && (request.headers.get('content-type') ?? '').includes('form')) {
		form = await request.formData();
	}
	locals.form = form;
	return form;
}

/** $_REQUEST before the token check: GET overlaid by POST, as PHP's default request_order "GP" builds it. */
export async function requestParams(request: Request, url: URL, locals: App.Locals): Promise<RequestParams> {
	const form = await requestForm(request, locals);
	return { ...paramsFrom(url.searchParams.entries()), ...paramsFrom(form?.entries() ?? []) };
}
