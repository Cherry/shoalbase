// Ports of Server\VariablesController (/server/variables) and Server\Variables\{Get,Set}VariableController.
import { selectMysqlForSuperUser } from './info-pages.ts';
import { withMysqlDie } from './mysql-die.ts';
import { renderServerTemplate } from './render.ts';
import { getVariableType, linkToVarDocumentation } from '../../../../lib/pma/server/kbs.ts';
import { phpEmpty } from '../../../../lib/pma/server/php.ts';
import {
	bytesText,
	formatVariable,
	isValidVariableName,
	setVariableValue,
} from '../../../../lib/pma/server/variables.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { FETCH_NUM } from '../../core/dbi.ts';
import { generatorState } from '../../core/generator.ts';

import type { PmaContext } from '../../core/context.ts';
import type { ControllerContext } from '../../dispatcher.ts';

export async function variablesController(context: PmaContext): Promise<Response> {
	const { dbi, response, request } = context;
	await selectMysqlForSuperUser(context);
	let filterValue = '';
	if (!phpEmpty(request.query.filter)) {
		filterValue = String(request.query.filter);
	}
	response.addScriptFiles(['server/variables.js']);

	const variables: Record<string, unknown>[] = [];
	const sessionResult = await dbi.tryQuery('SHOW SESSION VARIABLES;');
	if (sessionResult !== false) {
		const sessionValues = sessionResult.fetchAllKeyPair();
		const globalValues = await dbi.fetchResult<string>('SHOW GLOBAL VARIABLES;', 0, 1);
		const state = generatorState(context);
		for (const [name, value] of globalValues) {
			const sessionValue = sessionValues.get(name);
			const hasSessionValue = sessionValue !== undefined && sessionValue !== null && sessionValue !== value;
			const [formattedValue, isEscaped] = formatVariable(name, value);
			let sessionFormattedValue: string | null = null;
			if (hasSessionValue) {
				[sessionFormattedValue] = formatVariable(name, sessionValue);
			}
			variables.push({
				name,
				// The KBS provider lists no static variables, so every variable offers an edit link.
				is_editable: true,
				doc_link: linkToVarDocumentation(state, name, dbi.isMariaDB(), name.replaceAll('_', '&nbsp;')),
				value: formattedValue,
				is_escaped: isEscaped,
				has_session_value: hasSessionValue,
				session_value: sessionFormattedValue,
			});
		}
	}

	response.addHTML(await renderServerTemplate(context, 'server/variables/index', {
		variables,
		filter_value: filterValue,
		is_superuser: await dbi.isSuperUser(),
		is_mariadb: dbi.isMariaDB(),
	}));
	return response.response();
}

export async function getVariableController(context: ControllerContext): Promise<Response> {
	const { dbi, response } = context;
	if (!response.isAjax) {
		return response.response();
	}
	const name = context.params.name ?? '';
	// Single quotes keep the query working when the server runs in ANSI_QUOTES mode.
	const row = await dbi.fetchSingleRow(`SHOW GLOBAL VARIABLES WHERE Variable_name='${dbi.escapeString(name)}';`, FETCH_NUM);
	let message: string | null = row?.[1] ?? null;
	if (getVariableType(name) === 'byte') {
		message = bytesText(message ?? '', 3, 3);
	}
	response.addJSON({ message });
	return response.response();
}

export async function setVariableController(context: ControllerContext): Promise<Response> {
	const { dbi, response, request } = context;
	if (!response.isAjax) {
		return response.response();
	}
	const posted = request.post.varValue;
	const name = context.params.name ?? '';
	await dbi.connect();
	const value = setVariableValue(name, typeof posted === 'string' ? posted : '', text => dbi.escapeString(text));
	if (!isValidVariableName(name)) {
		response.setRequestStatus(false);
		response.addJSON({ error: 'Setting variable failed' });
		return response.response();
	}
	return withMysqlDie(context, async () => {
		await dbi.query(`SET GLOBAL ${name} = ${value}`);
		// The server may round the value, so it is read back.
		const row = await dbi.fetchSingleRow(`SHOW GLOBAL VARIABLES WHERE Variable_name="${dbi.escapeString(name)}";`, FETCH_NUM);
		const [formatted, isHtml] = formatVariable(name, row?.[1] ?? '');
		let variable = formatted;
		if (!isHtml) {
			variable = htmlspecialchars(formatted);
		}
		response.addJSON({ variable });
		return response.response();
	});
}

export const controllers = {
	'Server/VariablesController': variablesController,
	'Server/Variables/GetVariableController': getVariableController,
	'Server/Variables/SetVariableController': setVariableController,
};

