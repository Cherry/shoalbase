import {
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';

import {
	type RoutineRow,
	mapAliasToMysqlType,
	needsExecuteDialog,
	routineDataFromDefinition,
	routineDataFromRequest,
	routineExecuteQueries,
	routineParameters,
	routineQueryFromRequest,
	unQuote,
} from './routines.ts';
import { Context } from '../../../sql-parser/index.ts';
import { nestedParams } from '../table-data/php-params.ts';

import type { RequestParams } from '../../pma-request.ts';

const TYPES = ['INT', 'VARCHAR', 'DATE', 'TEXT', 'ENUM', 'VARBINARY', 'DECIMAL'];
const post = (params: RequestParams) => nestedParams(params);

beforeAll(() => {
	Context.loadClosest('MySql80400');
});

describe('mapAliasToMysqlType', () => {
	it('maps aliases and keeps other names, including inherited property names', () => {
		expect(mapAliasToMysqlType('BOOL')).toBe('TINYINT');
		expect(mapAliasToMysqlType('LONG VARCHAR')).toBe('MEDIUMTEXT');
		expect(mapAliasToMysqlType('INT')).toBe('INT');
		expect(mapAliasToMysqlType('constructor')).toBe('constructor');
	});
});

describe('unQuote', () => {
	it('strips one pair of quotes and unescapes doubled ones', () => {
		expect(unQuote('`a``b`')).toBe('a`b');
		expect(unQuote('"a""b"')).toBe('a"b');
		expect(unQuote('\'it\'\'s\'')).toBe('it\'s');
	});

	it('leaves unquoted, mismatched and single-character values alone', () => {
		expect(unQuote('abc')).toBe('abc');
		expect(unQuote('`abc"')).toBe('`abc"');
		expect(unQuote('`')).toBe('`');
	});
});

describe('routineQueryFromRequest', () => {
	it('builds a procedure with directions, lengths and options', () => {
		const query = routineQueryFromRequest(post({
			'item_type': 'PROCEDURE',
			'item_name': 'p`1',
			'item_definer': 'root@localhost',
			'item_param_dir[0]': 'IN',
			'item_param_name[0]': 'a',
			'item_param_type[0]': 'VARCHAR',
			'item_param_length[0]': '10',
			'item_param_opts_text[0]': 'UTF8MB4',
			'item_param_opts_num[0]': 'unsigned',
			'item_param_dir[1]': 'OUT',
			'item_param_name[1]': 'b',
			'item_param_type[1]': 'INT',
			'item_param_length[1]': '',
			'item_param_opts_text[1]': 'latin1',
			'item_param_opts_num[1]': 'zerofill',
			'item_comment': 'it\'s',
			'item_isdeterministic': '',
			'item_sqldataaccess': 'NO SQL',
			'item_securitytype': 'INVOKER',
			'item_definition': 'SELECT 1',
		}), TYPES);
		expect(query).toBe('CREATE DEFINER=`root`@`localhost` PROCEDURE `p``1`(IN `a` VARCHAR(10) CHARSET utf8mb4, OUT `b` INT ZEROFILL) '
			+ String.raw`COMMENT 'it\'s' DETERMINISTIC NO SQL SQL SECURITY INVOKER SELECT 1`);
	});

	it('builds a function with its return type', () => {
		const query = routineQueryFromRequest(post({
			'item_type': 'FUNCTION',
			'item_name': 'f',
			'item_definer': '`root`@`%`',
			'item_param_name[0]': 'd',
			'item_param_type[0]': 'DECIMAL',
			'item_param_length[0]': '5,2',
			'item_returntype': 'VARCHAR',
			'item_returnlength': '20',
			'item_returnopts_text': 'UTF8MB4',
			'item_returnopts_num': 'unsigned',
			'item_definition': 'RETURN 1',
		}), TYPES);
		expect(query).toBe('CREATE DEFINER=`root`@`%` FUNCTION `f`(`d` DECIMAL(5,2)) RETURNS VARCHAR(20) CHARSET utf8mb4 NOT DETERMINISTIC RETURN 1');
	});

	it('skips what upstream would only have reported as an error', () => {
		const query = routineQueryFromRequest(post({
			item_type: 'BOGUS',
			item_definer: 'nobody',
			item_securitytype: 'OTHER',
			item_sqldataaccess: 'ALL',
		}), TYPES);
		expect(query).toBe('CREATE () NOT DETERMINISTIC ');
	});

	it('stops at the first parameter without a name or type, keeping the separator', () => {
		const query = routineQueryFromRequest(post({
			'item_type': 'PROCEDURE',
			'item_name': 'p',
			'item_param_dir[0]': 'IN',
			'item_param_name[0]': 'a',
			'item_param_type[0]': 'TEXT',
			'item_param_length[0]': '9',
			'item_param_name[1]': '',
			'item_param_type[1]': 'INT',
			'item_param_length[1]': '',
		}), TYPES);
		expect(query).toBe('CREATE PROCEDURE `p`(IN `a` TEXT, ) NOT DETERMINISTIC ');
	});

	it('drops the name of a procedure parameter with an invalid direction and ignores scalar option fields', () => {
		const query = routineQueryFromRequest(post({
			'item_type': 'PROCEDURE',
			'item_name': 'p',
			'item_param_dir': 'SIDEWAYS',
			'item_param_name[0]': 'a',
			'item_param_type[0]': 'VARBINARY',
			'item_param_length[0]': '4',
			'item_param_opts_text': 'utf8mb4',
		}), TYPES);
		expect(query).toBe('CREATE PROCEDURE `p`((4)) NOT DETERMINISTIC ');
	});

	it('leaves out an unknown return type and lengths of types that take none', () => {
		const query = routineQueryFromRequest(post({
			item_type: 'FUNCTION',
			item_name: 'f',
			item_returntype: 'DATE',
			item_returnlength: '3',
			item_returnopts_text: 'utf8mb4',
		}), ['INT']);
		expect(query).toBe('CREATE FUNCTION `f`()  NOT DETERMINISTIC ');
	});

	it('adds numeric options to a numeric return type only', () => {
		const query = routineQueryFromRequest(post({ item_type: 'FUNCTION', item_name: 'f', item_returntype: 'INT', item_returnopts_num: 'unsigned', item_returnopts_text: 'utf8mb4' }), TYPES);
		expect(query).toBe('CREATE FUNCTION `f`() RETURNS INT UNSIGNED NOT DETERMINISTIC ');
	});
});

describe('routineDataFromRequest', () => {
	it('keeps the posted function values that pass validation', () => {
		const data = routineDataFromRequest(post({
			'item_type': 'FUNCTION',
			'item_original_type': 'FUNCTION',
			'item_name': 'f',
			'item_param_name[0]': 'a',
			'item_param_type[0]': 'BOGUS',
			'item_param_length[0]': '',
			'item_param_opts_num[0]': '',
			'item_param_opts_text[0]': '',
			'item_param_name[1]': 'b',
			'item_returntype': 'INT',
			'item_isdeterministic': 'ON',
			'item_securitytype': 'INVOKER',
			'item_sqldataaccess': 'NO SQL',
		}), TYPES);
		expect(data).toMatchObject({
			item_type: 'FUNCTION',
			item_type_toggle: 'PROCEDURE',
			item_original_type: 'FUNCTION',
			item_num_params: 2,
			item_param_dir: [],
			item_param_name: ['a', 'b'],
			item_param_type: [''],
			item_returntype: 'INT',
			item_isdeterministic: ' checked=\'checked\'',
			item_securitytype_definer: '',
			item_securitytype_invoker: ' selected=\'selected\'',
			item_sqldataaccess: 'NO SQL',
			item_comment: '',
		});
	});

	it('cleans procedure directions and falls back to defaults', () => {
		const withParams = routineDataFromRequest(post({
			'item_type': 'PROCEDURE',
			'item_param_dir[0]': 'IN',
			'item_param_dir[1]': 'UP',
			'item_param_name[0]': 'a',
			'item_param_type[0]': 'INT',
			'item_param_length[0]': '',
			'item_param_opts_num[0]': '',
			'item_param_opts_text[0]': '',
			'item_securitytype': 'DEFINER',
			'item_sqldataaccess': 'EVERYTHING',
		}), TYPES);
		expect(withParams).toMatchObject({ item_param_dir: ['IN', ''], item_securitytype_definer: ' selected=\'selected\'', item_sqldataaccess: '' });
		const lists = { 'item_param_name[0]': 'a', 'item_param_type[0]': 'INT', 'item_param_length[0]': '', 'item_param_opts_num[0]': '', 'item_param_opts_text[0]': '' };
		expect(routineDataFromRequest(post({ item_type: 'PROCEDURE', ...lists }), TYPES).item_param_dir).toEqual([]);
		expect(routineDataFromRequest(post({ item_type: 'PROCEDURE', item_param_dir: 'IN', ...lists }), TYPES).item_param_dir).toEqual([]);
		const empty = routineDataFromRequest(post({ item_param_name: 'scalar' }), TYPES);
		expect(empty).toMatchObject({ item_type: 'PROCEDURE', item_original_type: 'PROCEDURE', item_num_params: 0, item_returntype: '', item_isdeterministic: '' });
	});
});

const row = (values: Partial<RoutineRow>): RoutineRow => {
	return {
		SPECIFIC_NAME: 'r',
		ROUTINE_TYPE: 'PROCEDURE',
		DTD_IDENTIFIER: null,
		ROUTINE_DEFINITION: 'fallback body',
		IS_DETERMINISTIC: 'NO',
		SQL_DATA_ACCESS: 'CONTAINS SQL',
		ROUTINE_COMMENT: '',
		SECURITY_TYPE: 'DEFINER',
		...values,
	};
};

describe('routineDataFromDefinition', () => {
	it('reads parameters, body and options of a procedure', () => {
		const definition = 'CREATE DEFINER=`customer`@`%` PROCEDURE `r`(IN a INT UNSIGNED, OUT b ENUM(\'x\',\'y\'))\nBEGIN SELECT a; END';
		const data = routineDataFromDefinition(row({ IS_DETERMINISTIC: 'YES', ROUTINE_COMMENT: 'c' }), definition, true);
		expect(data).toMatchObject({
			item_name: 'r',
			item_num_params: 2,
			item_param_dir: ['IN', 'OUT'],
			item_param_name: ['a', 'b'],
			item_param_type: ['INT', 'ENUM'],
			item_param_length: ['', '\'x\',\'y\''],
			item_param_length_arr: [[], ['\'x\'', '\'y\'']],
			item_param_opts_num: ['UNSIGNED', ''],
			item_type_toggle: 'FUNCTION',
			item_returntype: '',
			item_definer: '`customer`@`%`',
			item_definition: 'BEGIN SELECT a; END',
			item_isdeterministic: ' checked=\'checked\'',
			item_securitytype_definer: ' selected=\'selected\'',
			item_sqldataaccess: 'CONTAINS SQL',
			item_comment: 'c',
		});
	});

	it('reads the return type of a function and stops early when only parameters are wanted', () => {
		const definition = 'CREATE FUNCTION `r`(a INT) RETURNS varchar(20) CHARSET utf8mb4\nRETURN a';
		const functionRow = row({ ROUTINE_TYPE: 'FUNCTION', DTD_IDENTIFIER: 'varchar(20)', SECURITY_TYPE: 'INVOKER' });
		expect(routineDataFromDefinition(functionRow, definition, true)).toMatchObject({
			item_type_toggle: 'PROCEDURE',
			item_returntype: 'VARCHAR',
			item_returnlength: '20',
			item_returnopts_text: 'utf8mb4',
			item_securitytype_invoker: ' selected=\'selected\'',
		});
		expect(routineDataFromDefinition(functionRow, definition, false)).not.toHaveProperty('item_definition');
		const unsigned = routineDataFromDefinition(functionRow, 'CREATE FUNCTION `r`() RETURNS INT UNSIGNED\nRETURN 1', true);
		expect(unsigned).toMatchObject({ item_returntype: 'INT', item_returnlength: '', item_returnopts_num: 'UNSIGNED' });
	});

	it('falls back to ROUTINE_DEFINITION when the parser finds no body', () => {
		expect(routineDataFromDefinition(row({}), 'CREATE PROCEDURE `r`()', true).item_definition).toBe('fallback body');
		expect(routineDataFromDefinition(row({ ROUTINE_DEFINITION: null }), 'CREATE PROCEDURE `r`()', true).item_definition).toBe('');
	});
});

describe('routineParameters and needsExecuteDialog', () => {
	it('only skips the dialog when every procedure parameter is OUT', () => {
		expect(needsExecuteDialog('PROCEDURE', routineParameters('CREATE PROCEDURE p(OUT a INT) SELECT 1'))).toBe(false);
		expect(needsExecuteDialog('PROCEDURE', routineParameters('CREATE PROCEDURE p(OUT a INT, b INT) SELECT 1'))).toBe(true);
		expect(needsExecuteDialog('FUNCTION', routineParameters('CREATE FUNCTION f(a INT) RETURNS INT RETURN a'))).toBe(true);
		expect(needsExecuteDialog('PROCEDURE', routineParameters('CREATE PROCEDURE p() SELECT 1'))).toBe(false);
	});
});

describe('routineExecuteQueries', () => {
	const procedure = {
		item_name: 'p',
		item_type: 'PROCEDURE',
		item_num_params: 4,
		item_param_dir: ['IN', 'OUT', 'INOUT', 'IN'],
		item_param_name: ['a', 'b', 'c', 'd'],
		item_param_type: ['INT', 'INT', 'SET', 'INT'],
		item_param_length: ['', '', '', ''],
		item_param_opts_num: [],
		item_param_opts_text: [],
	};

	it('sets the posted values, calls the procedure and selects its output parameters', () => {
		const queries = routineExecuteQueries(procedure, post({
			'params[a]': '1\'',
			'funcs[a]': 'ABS',
			'params[c]': ['x', 'y'],
			'funcs[c]': 'NOPE',
		}), ['ABS']);
		expect(queries).toEqual([
			'SET @p0=ABS(\'1\\\'\');\n',
			'SET @p2=\'x,y\';\n',
			'CALL `p`(@p0, @p1, @p2, @p3);\n',
			'SELECT @p1 AS `b`, @p2 AS `c`;\n',
		]);
	});

	it('selects the result of a function and skips the output select without output parameters', () => {
		expect(routineExecuteQueries({ ...procedure, item_type: 'FUNCTION', item_name: 'f', item_num_params: 1 }, post({}), [])).toEqual(['SELECT `f`(@p0) AS `f`;\n']);
		expect(routineExecuteQueries({ ...procedure, item_num_params: 1 }, post({}), [])).toEqual(['CALL `p`(@p0);\n']);
	});
});
