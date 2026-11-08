// TypeScript port of phpmyadmin/sql-parser 5.11.1 (as vendored by phpMyAdmin 5.2.3), with the PHP class names.
// Import from here: it loads the modules in an order that keeps their import cycles harmless.
export { Token, type TokenValue } from './Token.ts';
export { TokensList } from './TokensList.ts';
export { Context } from './Context.ts';
export { Translator } from './Translator.ts';
export { Core } from './Core.ts';
export { Lexer } from './Lexer.ts';
export { Parser } from './Parser.ts';
export {
	Statement, type Clause, type Clauses, type StatementClass,
} from './Statement.ts';
export { Component, type ComponentClass, type ComponentOptions } from './Component.ts';
export { LexerException, LoaderException, ParserException } from './exceptions.ts';
export {
	AlterOperation, Array2d, ArrayObj, CaseExpression, Condition, CreateDefinition, DataType, Expression, ExpressionArray, FunctionCall,
	GroupKeyword, IndexHint, IntoKeyword, JoinKeyword, Key, Limit, LockExpression, OptionsArray, OrderKeyword, ParameterDefinition,
	PartitionDefinition, Reference, RenameOperation, SetOperation, UnionKeyword, WithKeyword,
} from './components/index.ts';
export {
	isOptionEntry, type OptionEntry, type OptionsMap, type OptionSpec, type OptionsSpec, type OptionValue,
} from './components/OptionsArray.ts';
export type { ExpressionOptions } from './components/Expression.ts';
export type { KeyColumn } from './components/Key.ts';
export {
	AlterStatement, AnalyzeStatement, BackupStatement, CallStatement, CheckStatement, ChecksumStatement, CreateStatement, DeleteStatement,
	DropStatement, ExplainStatement, InsertStatement, KillStatement, LoadStatement, LockStatement, MaintenanceStatement,
	NotImplementedStatement, OptimizeStatement, PurgeStatement, RenameStatement, RepairStatement, ReplaceStatement, RestoreStatement,
	SelectStatement, SetStatement, ShowStatement, TransactionStatement, TruncateStatement, UpdateStatement, WithStatement,
} from './statements/index.ts';
export {
	type AnalyzedQuery, Query, type QueryFlags, type SelectTable,
} from './utils/Query.ts';
export {
	type Format, Formatter, type FormatterInput, type FormatterOptions,
} from './utils/Formatter.ts';
export { BufferedQuery, type BufferedQueryOptions } from './utils/BufferedQuery.ts';
export { ParserError, type ParserErrorEntry } from './utils/Error.ts';
export { type DatabaseAliases, Misc, type TableAliases } from './utils/Misc.ts';
export { Routine, type RoutineParameter, type RoutineParameters } from './utils/Routine.ts';
export { type ForeignKey, Table, type TableField } from './utils/Table.ts';
export { type TokenPattern, Tokens } from './utils/Tokens.ts';
