// Port of PhpMyAdmin\SqlParser\Statements\RepairStatement.
import { MaintenanceStatement } from './MaintenanceStatement.ts';

import type { OptionsSpec } from '../components/OptionsArray.ts';

export class RepairStatement extends MaintenanceStatement {
	static override OPTIONS: OptionsSpec = {
		TABLE: 1,
		NO_WRITE_TO_BINLOG: 2,
		LOCAL: 3,
		QUICK: 4,
		EXTENDED: 5,
		USE_FRM: 6,
	};
}
