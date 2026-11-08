// Ports of Export\Template\*Controller: without the configuration storage they return before doing anything.
import type { Controller } from '../../dispatcher.ts';

const noExportTemplatesFeature: Controller = async context => context.response.response();

export const controllers: Record<string, Controller> = {
	'Export/Template/CreateController': noExportTemplatesFeature,
	'Export/Template/DeleteController': noExportTemplatesFeature,
	'Export/Template/LoadController': noExportTemplatesFeature,
	'Export/Template/UpdateController': noExportTemplatesFeature,
};
