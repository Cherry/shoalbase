// Port of PhpMyAdmin\SqlParser\Statements\CheckStatement.
import { MaintenanceStatement } from './MaintenanceStatement.ts';

import type { OptionsSpec } from '../components/OptionsArray.ts';

export class CheckStatement extends MaintenanceStatement {
	static override OPTIONS: OptionsSpec = {
		'TABLE': 1,
		'FOR UPGRADE': 2,
		'QUICK': 3,
		'FAST': 4,
		'MEDIUM': 5,
		'EXTENDED': 6,
		'CHANGED': 7,
	};
}
