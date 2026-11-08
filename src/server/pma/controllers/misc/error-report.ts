// ErrorReportController: the JavaScript error report dialog and its settings.
import { Message } from '../../../../lib/pma/message.ts';
import { jsErrorReport, nestedParam } from '../../../../lib/pma/misc/error-report.ts';
import { persistOption } from '../../../../lib/pma/user-preferences.ts';
import { PHP_VERSION } from '../../../../lib/pma/version-check.ts';
import { getHiddenFields, getHiddenInputs } from '../../../../lib/twig/url.ts';
import { renderTemplate } from '../../../twig/render.ts';

import type { ControllerContext } from '../../dispatcher.ts';

// $_SERVER['SERVER_SOFTWARE'] of the phpmyadmin:5.2 image.
const SERVER_SOFTWARE = 'Apache/2.4.69 (Debian)';

const isTruthy = (value: unknown): boolean => value !== undefined && value !== '' && value !== '0';

function reportData(context: ControllerContext): Record<string, unknown> {
	const { post } = context.request;
	return jsErrorReport(nestedParam(post, 'exception'), post.url, post.description, {
		userAgent: context.astro.request.headers.get('user-agent') ?? '',
		serverSoftware: SERVER_SOFTWARE,
		locale: context.getCookie('pma_lang') ?? null,
		phpVersion: PHP_VERSION,
	});
}

/**
 * The send_error_report branch. Reports are not forwarded to reports.phpmyadmin.net, since they describe this port rather
 * than phpMyAdmin, so the user sees upstream's "failed to be sent" message.
 */
function sendReport(context: ControllerContext, exceptionType: string): void {
	const { post } = context.request;
	const { response, session } = context;
	if (exceptionType === 'php') {
		const data = session.data as Record<string, unknown>;
		const count = typeof data.error_subm_count === 'number' ? data.error_subm_count : null;
		const previous = typeof data.prev_error_subm_time === 'number' ? data.prev_error_subm_time : null;
		const now = Math.floor(Date.now() / 1000);
		// Stops a loop of failing PHP error submissions.
		if (previous !== null && count !== null && count >= 3 && previous - now <= 3000) {
			data.error_subm_count = 0;
			data.prev_errors = '';
			response.addJSON('stopErrorReportLoop', '1');
		} else {
			data.prev_error_subm_time = now;
			data.error_subm_count = count === null ? 0 : count + 1;
		}
		// No PHP errors are ever collected here, so there is nothing to report.
		return;
	}
	if (Object.keys(reportData(context)).length === 0) {
		return;
	}
	const message = Message.error('An error has been detected and an error report has been generated but failed to be sent. '
		+ 'If you experience any problems please submit a bug report manually. You may want to refresh the page.');
	if (response.isAjax) {
		response.addJSON('message', message);
	}
	if (post.always_send === 'true') {
		persistOption(session, 'SendErrorReports', 'always', 'ask', Math.floor(Date.now() / 1000));
	}
}

export async function errorReportController(context: ControllerContext): Promise<Response> {
	const { config, request, response } = context;
	const { post } = request;
	const exceptionType = typeof post.exception_type === 'string' ? post.exception_type : '';
	if (exceptionType !== 'js' && exceptionType !== 'php') {
		return response.response();
	}
	const allowed = config.SendErrorReports !== 'never';
	if (isTruthy(post.send_error_report)) {
		sendReport(context, exceptionType);
	} else if (isTruthy(post.get_settings)) {
		response.addJSON('report_setting', config.SendErrorReports);
	} else if (exceptionType === 'js') {
		const state = await context.templateState();
		response.addJSON('report_modal', await renderTemplate('error/report_modal', { allowed_to_send_error_reports: allowed }, state));
		const data = reportData(context);
		let hiddenFields: string | null = null;
		if (Object.keys(data).length > 0) {
			hiddenFields = getHiddenFields(context.urlState(), data, '', true);
		}
		response.addHTML(await renderTemplate('error/report_form', {
			report_data: data,
			hidden_inputs: getHiddenInputs(context.urlState()),
			hidden_fields: hiddenFields,
			allowed_to_send_error_reports: allowed,
			JSON_PRETTY_PRINT: 128,
			JSON_UNESCAPED_SLASHES: 64,
		}, state));
	}
	return response.response();
}

export const controllers = {
	ErrorReportController: errorReportController,
};
