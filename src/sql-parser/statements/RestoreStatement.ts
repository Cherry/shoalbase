// Port of PhpMyAdmin\SqlParser\Statements\RestoreStatement.
import { MaintenanceStatement } from './MaintenanceStatement.ts';

import type { OptionsSpec } from '../components/OptionsArray.ts';

export class RestoreStatement extends MaintenanceStatement {
	static override OPTIONS: OptionsSpec = {
		TABLE: 1,
		FROM: [2, 'var'],
	};
}
