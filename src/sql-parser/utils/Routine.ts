// Port of PhpMyAdmin\SqlParser\Utils\Routine: return types and parameters of stored routines.
import { DataType } from '../components/DataType.ts';
import { type OptionValue, isOptionEntry } from '../components/OptionsArray.ts';
import { ParameterDefinition } from '../components/ParameterDefinition.ts';
import { Lexer } from '../Lexer.ts';
import { Parser } from '../Parser.ts';
import { member, phpEmpty, phpStr } from '../php.ts';

import type { CreateStatement } from '../statements/CreateStatement.ts';
import type { TokenValue } from '../Token.ts';

/** [direction, name, type, length, options]. */
export type RoutineParameter = [string, string, string, string, string];

export interface RoutineParameters {
	num: number;
	dir: TokenValue[];
	name: TokenValue[];
	type: (string | null)[];
	length: string[];
	length_arr: string[][];
	opts: string[];
}

/** is_string($opt) ? $opt : $opt['value']. */
function optionText(option: OptionValue): string {
	if (isOptionEntry(option)) {
		return phpStr(option.value);
	}
	return phpStr(option);
}

export const Routine = {
	/** The parts of a return type: ['', '', type, length, options]. */
	getReturnType(param: string): RoutineParameter {
		const lexer = new Lexer(param);

		// A dummy parser is used for error reporting.
		const type = DataType.parse(new Parser(), lexer.list);

		if (type === null) {
			return ['', '', '', '', ''];
		}

		const options = [...(type.options?.options.values() ?? [])].map(option => optionText(option));

		return ['', '', phpStr(type.name), type.parameters.join(','), options.join(' ')];
	},

	/** The parts of a parameter: [direction, name, type, length, options]. */
	getParameter(param: string): RoutineParameter {
		const lexer = new Lexer(`(${param})`);

		// A dummy parser is used for error reporting.
		const params = ParameterDefinition.parse(new Parser(), lexer.list);

		if (phpEmpty(params[0])) {
			return ['', '', '', '', ''];
		}

		const parameter = params[0];
		// A parameter without a type makes PHP fail in implode().
		const type = member(parameter.type);
		const options = [...(type.options?.options.values() ?? [])].map(option => optionText(option));

		return [
			phpEmpty(parameter.inOut) ? '' : phpStr(parameter.inOut),
			phpStr(parameter.name),
			phpStr(type.name),
			type.parameters.join(','),
			options.join(' '),
		];
	},

	/** The parameters of a CREATE PROCEDURE/FUNCTION statement, by property. */
	getParameters(statement: CreateStatement): RoutineParameters {
		const retval: RoutineParameters = {
			num: 0,
			dir: [],
			name: [],
			type: [],
			length: [],
			length_arr: [],
			opts: [],
		};

		if (!phpEmpty(statement.parameters)) {
			let idx = 0;
			for (const param of statement.parameters ?? []) {
				retval.dir[idx] = param.inOut;
				retval.name[idx] = param.name;
				const type = member(param.type);
				retval.type[idx] = type.name;
				retval.length[idx] = type.parameters.join(',');
				retval.length_arr[idx] = type.parameters;
				retval.opts[idx] = [...(type.options?.options.values() ?? [])].map(option => optionText(option)).join(' ');
				++idx;
			}

			retval.num = idx;
		}

		return retval;
	},
};
