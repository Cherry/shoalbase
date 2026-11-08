// Renders a server page template with Map-shaped data converted to Twig arrays all the way down.
import { twigVariables } from '../../../../lib/pma/server/twig-data.ts';
import { renderTemplate } from '../../../twig/render.ts';

import type { PmaContext } from '../../core/context.ts';

export async function renderServerTemplate(context: PmaContext, name: string, variables: Record<string, unknown>): Promise<string> {
	return renderTemplate(name, twigVariables(variables), await context.templateState());
}
