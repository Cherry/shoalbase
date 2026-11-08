// Port of Controllers\SchemaExportController (/schema-export) and Export::processExportSchema() with the Plugins\Schema exporters.
import { noCacheHeaders } from '../../../../lib/pma/ajax-response.ts';
import { encodeOutput } from '../../../../lib/pma/export-import/bytes.ts';
import { sanitizeFilename } from '../../../../lib/pma/export-import/filename.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { diaSchema } from '../../schema/dia.ts';
import { epsSchema } from '../../schema/eps.ts';
import { pdfSchema } from '../../schema/pdf.ts';
import { schemaRequest } from '../../schema/request.ts';
import { svgSchema } from '../../schema/svg.ts';
import { MissingTableError } from '../../schema/table-stats.ts';
import { fatalError, missingParameters } from '../export-import/export.ts';

import type { PmaContext } from '../../core/context.ts';
import type { Controller, ControllerContext } from '../../dispatcher.ts';

const EXPORTERS: Record<string, { label: string; extension: string; mimeType: string; }> = {
	dia: { label: 'DIA', extension: '.dia', mimeType: 'application/x-dia-diagram' },
	eps: { label: 'EPS', extension: '.eps', mimeType: 'image/x-eps' },
	pdf: { label: 'PDF', extension: '.pdf', mimeType: 'application/pdf' },
	svg: { label: 'SVG', extension: '.svg', mimeType: 'image/svg+xml' },
};

/** ExportRelationSchema::dieSchema(): the message is echoed into the page before exit. */
function dieSchema(context: PmaContext, pageNumber: number, type: string, message: string): Promise<Response> {
	const back = getFromRoute(context.urlState(), '/database/designer', { db: context.db, server: context.server, page: pageNumber });
	context.response.addHTML(`<p><strong>SCHEMA ERROR: ${type}</strong></p>\n<p>\n    ${htmlspecialchars(message)}\n</p>\n<a href="${back}">Back</a>\n`);
	return context.response.response();
}

/** Core::downloadHeader() on a disabled response, with the body sent as bytes. */
async function download(context: PmaContext, filename: string, mimeType: string, body: Uint8Array): Promise<Response> {
	const { response } = context;
	response.disable();
	for (const [name, value] of noCacheHeaders(new Date())) {
		response.header(name, value);
	}
	const safeName = sanitizeFilename(filename);
	if (safeName !== '') {
		response.header('Content-Description', 'File Transfer');
		response.header('Content-Disposition', `attachment; filename="${safeName}"`);
	}
	response.header('Content-Type', mimeType);
	response.header('Content-Transfer-Encoding', 'binary');
	const rendered = await response.response();
	return new Response(body as Uint8Array<ArrayBuffer>, { status: rendered.status, headers: rendered.headers });
}

async function schemaExport(context: ControllerContext): Promise<Response> {
	const { post } = context.request;
	const posted = post.export_type;
	if (posted === undefined) {
		return missingParameters(context, ['export_type']);
	}
	const exportType = typeof posted === 'string' && /^[a-z]+$/i.test(posted) ? posted.toLowerCase() : 'pdf';
	if (!Object.hasOwn(EXPORTERS, exportType)) {
		return fatalError(context, 'Bad type!');
	}
	const exporter = EXPORTERS[exportType];
	const db = typeof post.db === 'string' ? post.db : '';
	await context.dbi.selectDb(db);

	const request = schemaRequest(context, db);
	let body: string | Uint8Array;
	try {
		if (exportType === 'svg') {
			body = await svgSchema(request);
		} else if (exportType === 'dia') {
			body = await diaSchema(request);
		} else if (exportType === 'eps') {
			body = await epsSchema(request, new Date());
		} else {
			body = await pdfSchema(request, new Date());
		}
	} catch (error) {
		if (error instanceof MissingTableError) {
			return dieSchema(context, request.pageNumber, exporter.label, error.message);
		}
		throw error;
	}
	const bytes = typeof body === 'string' ? encodeOutput(body) : body;
	return download(context, `${db}${exporter.extension}`, exporter.mimeType, bytes);
}

export const controllers: Record<string, Controller> = {
	SchemaExportController: schemaExport,
};
