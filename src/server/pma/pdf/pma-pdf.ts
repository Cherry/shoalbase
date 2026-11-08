// Port of PhpMyAdmin\Pdf: TCPDF with phpMyAdmin's author, 14pt font and "Page number" footer.
import {
	ALIAS_NB_PAGES,
	ALIAS_NUM_PAGE,
	type Orientation,
	Tcpdf,
} from '../../../lib/pma/pdf/tcpdf.ts';
import { localisedDate } from '../../../lib/pma/util.ts';

export class PmaPdf extends Tcpdf {
	private readonly footerSet = new Set<number>();

	constructor(orientation: Orientation = 'P', unit: 'mm' | 'pt' = 'mm', format = 'A4') {
		super(orientation, unit, format);
		this.author = 'phpMyAdmin 5.2.3';
		this.setFont('', 14);
		this.footerFontSize = 14;
	}

	/** Pdf::Footer(): the page number and today's date, once per page. */
	override footer(): void {
		if (this.footerSet.has(this.page)) {
			return;
		}
		this.setY(-15);
		this.setFont('', 14);
		this.cell(0, 6, `Page number: ${ALIAS_NUM_PAGE}/${ALIAS_NB_PAGES}`, 'T', 0, 'C');
		this.cell(0, 6, localisedDate(), 0, 1, 'R');
		this.setY(20);
		this.footerSet.add(this.page);
	}
}
