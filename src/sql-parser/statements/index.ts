// The statements by class name, for Parser::$STATEMENT_PARSERS lookups; resolved lazily so import cycles stay harmless.
import { AlterStatement } from './AlterStatement.ts';
import { AnalyzeStatement } from './AnalyzeStatement.ts';
import { BackupStatement } from './BackupStatement.ts';
import { CallStatement } from './CallStatement.ts';
import { CheckStatement } from './CheckStatement.ts';
import { ChecksumStatement } from './ChecksumStatement.ts';
import { CreateStatement } from './CreateStatement.ts';
import { DeleteStatement } from './DeleteStatement.ts';
import { DropStatement } from './DropStatement.ts';
import { ExplainStatement } from './ExplainStatement.ts';
import { InsertStatement } from './InsertStatement.ts';
import { KillStatement } from './KillStatement.ts';
import { LoadStatement } from './LoadStatement.ts';
import { LockStatement } from './LockStatement.ts';
import { OptimizeStatement } from './OptimizeStatement.ts';
import { PurgeStatement } from './PurgeStatement.ts';
import { RenameStatement } from './RenameStatement.ts';
import { RepairStatement } from './RepairStatement.ts';
import { ReplaceStatement } from './ReplaceStatement.ts';
import { RestoreStatement } from './RestoreStatement.ts';
import { SelectStatement } from './SelectStatement.ts';
import { SetStatement } from './SetStatement.ts';
import { ShowStatement } from './ShowStatement.ts';
import { TransactionStatement } from './TransactionStatement.ts';
import { TruncateStatement } from './TruncateStatement.ts';
import { UpdateStatement } from './UpdateStatement.ts';
import { WithStatement } from './WithStatement.ts';

import type { StatementClass } from '../Statement.ts';

export {
	AlterStatement, AnalyzeStatement, BackupStatement, CallStatement, CheckStatement, ChecksumStatement, CreateStatement, DeleteStatement,
	DropStatement, ExplainStatement, InsertStatement, KillStatement, LoadStatement, LockStatement,
	OptimizeStatement, PurgeStatement, RenameStatement, RepairStatement, ReplaceStatement, RestoreStatement,
	SelectStatement, SetStatement, ShowStatement, TransactionStatement, TruncateStatement, UpdateStatement, WithStatement,
};

let classes: Record<string, StatementClass> | undefined;

export function statementClass(name: string): StatementClass {
	classes ??= {
		AlterStatement,
		AnalyzeStatement,
		BackupStatement,
		CallStatement,
		CheckStatement,
		ChecksumStatement,
		CreateStatement,
		DeleteStatement,
		DropStatement,
		ExplainStatement,
		InsertStatement,
		KillStatement,
		LoadStatement,
		LockStatement,
		OptimizeStatement,
		PurgeStatement,
		RenameStatement,
		RepairStatement,
		ReplaceStatement,
		RestoreStatement,
		SelectStatement,
		SetStatement,
		ShowStatement,
		TransactionStatement,
		TruncateStatement,
		UpdateStatement,
		WithStatement,
	};
	const found = classes[name];
	if (found === undefined) {
		throw new Error(`Unknown statement ${name}`);
	}
	return found;
}

export { MaintenanceStatement } from './MaintenanceStatement.ts';

export { NotImplementedStatement } from './NotImplementedStatement.ts';
