// Port of PhpMyAdmin\SqlParser\Statements\BackupStatement.
import { MaintenanceStatement } from './MaintenanceStatement.ts';

import type { OptionsSpec } from '../components/OptionsArray.ts';

export class BackupStatement extends MaintenanceStatement {
	static override OPTIONS: OptionsSpec = {
		TABLE: 1,
		NO_WRITE_TO_BINLOG: 2,
		LOCAL: 3,
		TO: [4, 'var'],
	};
}
