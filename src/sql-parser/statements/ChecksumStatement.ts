// Port of PhpMyAdmin\SqlParser\Statements\ChecksumStatement.
import { MaintenanceStatement } from './MaintenanceStatement.ts';

import type { OptionsSpec } from '../components/OptionsArray.ts';

export class ChecksumStatement extends MaintenanceStatement {
	static override OPTIONS: OptionsSpec = {
		TABLE: 1,
		QUICK: 2,
		EXTENDED: 3,
	};
}
