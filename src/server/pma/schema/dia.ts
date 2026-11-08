// Port of Plugins\Schema\Dia\DiaRelationSchema, TableStatsDia and RelationStatsDia.
import {
	type TableStats,
	fieldPosition,
	forEachRelation,
	getTablesFromRequest,
	loadTableStats,
	randomColor,
} from './table-stats.ts';
import { XmlWriter } from './xml-writer.ts';
import { phpString } from '../../../lib/twig/php.ts';

import type { SchemaRequest } from './request.ts';

const MARGIN = phpString(2.8222000598907471);

function diagramData(paper: string, isPortrait: boolean): string {
	return `<dia:attribute name="background">
              <dia:color val="#ffffff"/>
            </dia:attribute>
            <dia:attribute name="pagebreak">
              <dia:color val="#000099"/>
            </dia:attribute>
            <dia:attribute name="paper">
              <dia:composite type="paper">
                <dia:attribute name="name">
                  <dia:string>#${paper}#</dia:string>
                </dia:attribute>
                <dia:attribute name="tmargin">
                  <dia:real val="${MARGIN}"/>
                </dia:attribute>
                <dia:attribute name="bmargin">
                  <dia:real val="${MARGIN}"/>
                </dia:attribute>
                <dia:attribute name="lmargin">
                  <dia:real val="${MARGIN}"/>
                </dia:attribute>
                <dia:attribute name="rmargin">
                  <dia:real val="${MARGIN}"/>
                </dia:attribute>
                <dia:attribute name="is_portrait">
                  <dia:boolean val="${isPortrait ? 'true' : 'false'}"/>
                </dia:attribute>
                <dia:attribute name="scaling">
                  <dia:real val="1"/>
                </dia:attribute>
                <dia:attribute name="fitto">
                  <dia:boolean val="false"/>
                </dia:attribute>
              </dia:composite>
            </dia:attribute>
            <dia:attribute name="grid">
              <dia:composite type="grid">
                <dia:attribute name="width_x">
                  <dia:real val="1"/>
                </dia:attribute>
                <dia:attribute name="width_y">
                  <dia:real val="1"/>
                </dia:attribute>
                <dia:attribute name="visible_x">
                  <dia:int val="1"/>
                </dia:attribute>
                <dia:attribute name="visible_y">
                  <dia:int val="1"/>
                </dia:attribute>
                <dia:composite type="color"/>
              </dia:composite>
            </dia:attribute>
            <dia:attribute name="color">
              <dia:color val="#d8e5e5"/>
            </dia:attribute>
            <dia:attribute name="guides">
              <dia:composite type="guides">
                <dia:attribute name="hguides"/>
                <dia:attribute name="vguides"/>
              </dia:composite>
            </dia:attribute>`;
}

function tableAttributes(stats: TableStats, color: string): string {
	const x = phpString(stats.x * 0.1);
	const y = phpString(stats.y * 0.1);
	return `<dia:attribute name="obj_pos">
                <dia:point val="${x},${y}"/>
            </dia:attribute>
            <dia:attribute name="obj_bb">
                <dia:rectangle val="${x},${y};9.97,9.2"/>
            </dia:attribute>
            <dia:attribute name="meta">
                <dia:composite type="dict"/>
            </dia:attribute>
            <dia:attribute name="elem_corner">
                <dia:point val="${x},${y}"/>
            </dia:attribute>
            <dia:attribute name="elem_width">
                <dia:real val="5.9199999999999999"/>
            </dia:attribute>
            <dia:attribute name="elem_height">
                <dia:real val="3.5"/>
            </dia:attribute>
            <dia:attribute name="text_colour">
                <dia:color val="${color}"/>
            </dia:attribute>
            <dia:attribute name="line_colour">
                <dia:color val="#000000"/>
            </dia:attribute>
            <dia:attribute name="fill_colour">
                <dia:color val="#ffffff"/>
            </dia:attribute>
            <dia:attribute name="line_width">
                <dia:real val="0.10000000000000001"/>
            </dia:attribute>
            <dia:attribute name="name">
                <dia:string>#${stats.tableName}#</dia:string>
            </dia:attribute>
            <dia:attribute name="comment">
                <dia:string>##</dia:string>
            </dia:attribute>
            <dia:attribute name="visible_comment">
                <dia:boolean val="false"/>
            </dia:attribute>
            <dia:attribute name="tagging_comment">
                <dia:boolean val="false"/>
            </dia:attribute>
            <dia:attribute name="underline_primary_key">
                <dia:boolean val="true"/>
            </dia:attribute>
            <dia:attribute name="bold_primary_keys">
                <dia:boolean val="true"/>
            </dia:attribute>
            <dia:attribute name="normal_font">
                <dia:font family="monospace" style="0" name="Courier"/>
            </dia:attribute>
            <dia:attribute name="name_font">
                <dia:font family="sans" style="80" name="Helvetica-Bold"/>
            </dia:attribute>
            <dia:attribute name="comment_font">
                <dia:font family="sans" style="0" name="Helvetica"/>
            </dia:attribute>
            <dia:attribute name="normal_font_height">
                <dia:real val="0.80000000000000004"/>
            </dia:attribute>
            <dia:attribute name="name_font_height">
                <dia:real val="0.69999999999999996"/>
            </dia:attribute>
            <dia:attribute name="comment_font_height">
                <dia:real val="0.69999999999999996"/>
            </dia:attribute>`;
}

function fieldAttributes(field: string, primaryKey: string): string {
	return `<dia:composite type="table_attribute">
                    <dia:attribute name="name">
                <dia:string>#${field}#</dia:string>
                </dia:attribute>
                <dia:attribute name="type">
                    <dia:string>##</dia:string>
                </dia:attribute>
                    <dia:attribute name="comment">
                <dia:string>##</dia:string>
                </dia:attribute><dia:attribute name="primary_key">
                    <dia:boolean val="${primaryKey}"/>
                </dia:attribute>
                <dia:attribute name="nullable">
                    <dia:boolean val="false"/>
                </dia:attribute>
                <dia:attribute name="unique">
                    <dia:boolean val="${primaryKey}"/>
                </dia:attribute>
                </dia:composite>`;
}

function reference(id: number, color: string, masterId: number, masterConnection: number, foreignId: number, foreignConnection: number): string {
	return `<dia:object type="Database - Reference" version="0" id="${id}">
            <dia:attribute name="obj_pos">
                <dia:point val="3.27,18.9198"/>
            </dia:attribute>
            <dia:attribute name="obj_bb">
                <dia:rectangle val="2.27,8.7175;17.7679,18.9198"/>
            </dia:attribute>
            <dia:attribute name="meta">
                <dia:composite type="dict"/>
            </dia:attribute>
            <dia:attribute name="orth_points">
                <dia:point val="3.27,18.9198"/>
                <dia:point val="2.27,18.9198"/>
                <dia:point val="2.27,14.1286"/>
                <dia:point val="17.7679,14.1286"/>
                <dia:point val="17.7679,9.3375"/>
                <dia:point val="16.7679,9.3375"/>
            </dia:attribute>
            <dia:attribute name="orth_orient">
                <dia:enum val="0"/>
                <dia:enum val="1"/>
                <dia:enum val="0"/>
                <dia:enum val="1"/>
                <dia:enum val="0"/>
            </dia:attribute>
            <dia:attribute name="orth_autoroute">
                <dia:boolean val="true"/>
            </dia:attribute>
            <dia:attribute name="text_colour">
                <dia:color val="#000000"/>
            </dia:attribute>
            <dia:attribute name="line_colour">
                <dia:color val="${color}"/>
            </dia:attribute>
            <dia:attribute name="line_width">
                <dia:real val="0.10000000000000001"/>
            </dia:attribute>
            <dia:attribute name="line_style">
                <dia:enum val="0"/>
                <dia:real val="1"/>
            </dia:attribute>
            <dia:attribute name="corner_radius">
                <dia:real val="0"/>
            </dia:attribute>
            <dia:attribute name="end_arrow">
                <dia:enum val="22"/>
            </dia:attribute>
            <dia:attribute name="end_arrow_length">
                <dia:real val="0.5"/>
            </dia:attribute>
            <dia:attribute name="end_arrow_width">
                <dia:real val="0.5"/>
            </dia:attribute>
            <dia:attribute name="start_point_desc">
                <dia:string>#1#</dia:string>
            </dia:attribute>
            <dia:attribute name="end_point_desc">
                <dia:string>#n#</dia:string>
            </dia:attribute>
            <dia:attribute name="normal_font">
                <dia:font family="monospace" style="0" name="Courier"/>
            </dia:attribute>
            <dia:attribute name="normal_font_height">
                <dia:real val="0.59999999999999998"/>
            </dia:attribute>
            <dia:connections>
                <dia:connection handle="0" to="${masterId}" connection="${masterConnection}"/>
                <dia:connection handle="1" to="${foreignId}" connection="${foreignConnection}"/>
            </dia:connections>
            </dia:object>`;
}

/** RelationStatsDia::getXy(): the [left, right] connection points of a column. */
function connectionPoints(table: TableStats, column: string): [number, number] {
	const position = Number(fieldPosition(table, column));
	if (position !== 0) {
		return [position + 12 + position, position + 12 + position + 1];
	}
	return [12, 13];
}

const TABLE_COLORS = ['#FF0000', '#000099', '#00FF00'];

/** DiaRelationSchema::__construct(): the whole document. */
export async function diaSchema(request: SchemaRequest): Promise<string> {
	const { context, post, db, has } = request;
	const showColor = has('dia_show_color');
	const showKeys = has('dia_show_keys');
	const orientation = request.string('dia_orientation') === 'P' ? 'P' : 'L';
	const paper = request.string('dia_paper');

	const dia = new XmlWriter();
	dia.startDocument();
	dia.startElement('dia:diagram');
	// The Dia namespace is an identifier, not a link, so it keeps upstream's http.
	// eslint-disable-next-line unicorn/prefer-https
	dia.writeAttribute('xmlns:dia', 'http://www.lysator.liu.se/~alla/dia/');
	dia.startElement('dia:diagramdata');
	dia.writeRaw(diagramData(paper, orientation === 'P'));
	dia.endElement();
	dia.startElement('dia:layer');
	dia.writeAttribute('name', 'Background');
	dia.writeAttribute('visible', 'true');
	dia.writeAttribute('active', 'true');

	let objectId = 0;
	const tables = new Map<string, { stats: TableStats; id: number; }>();
	const allTables = getTablesFromRequest(post);
	for (const name of allTables) {
		if (tables.has(name)) {
			continue;
		}

		const stats = await loadTableStats(context, post, db, name, showKeys, false);
		tables.set(name, { stats, id: ++objectId });
	}

	const relations: { masterId: number; foreignId: number; src: [number, number]; dest: [number, number]; }[] = [];
	const seenRelation = await forEachRelation(context, db, allTables, async (masterTable, masterField, foreignTable, foreignField) => {
		const master = tables.get(masterTable) as { stats: TableStats; id: number; };
		const foreign = tables.get(foreignTable) as { stats: TableStats; id: number; };
		relations.push({
			masterId: master.id,
			foreignId: foreign.id,
			src: connectionPoints(master.stats, masterField),
			dest: connectionPoints(foreign.stats, foreignField),
		});
	});

	for (const { stats, id } of tables.values()) {
		const color = showColor ? randomColor(TABLE_COLORS) : '#000000';
		dia.startElement('dia:object');
		dia.writeAttribute('type', 'Database - Table');
		dia.writeAttribute('version', '0');
		dia.writeAttribute('id', String(id));
		dia.writeRaw(tableAttributes(stats, color));
		dia.startElement('dia:attribute');
		dia.writeAttribute('name', 'attributes');
		for (const field of stats.fields) {
			const primaryKey = stats.primary.includes(field) && field !== stats.displayfield ? 'true' : 'false';
			dia.writeRaw(fieldAttributes(field, primaryKey));
		}
		dia.endElement();
		dia.endElement();
	}

	if (seenRelation) {
		for (const relation of relations) {
			objectId++;
			// A relation between the same connection points is skipped, though it still used up an id.
			if (relation.src[1] === relation.dest[1] && relation.src[0] === relation.dest[0]) {
				continue;
			}
			const color = showColor ? randomColor(TABLE_COLORS) : '#000000';
			dia.writeRaw(reference(objectId, color, relation.masterId, relation.src[1], relation.foreignId, relation.dest[1]));
		}
	}
	dia.endElement();
	dia.endDocument();
	return dia.flush();
}
