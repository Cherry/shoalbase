// Port of PhpMyAdmin\SqlParser\Components\UnionKeyword: builds the [type, statement] pairs of UNION/EXCEPT/INTERSECT.
import { Component } from '../Component.ts';
import { phpStr } from '../php.ts';
import { Translator } from '../Translator.ts';

export type UnionPart = [string, unknown];

export class UnionKeyword extends Component {
	/** Component::parse(): unions are parsed by the Parser itself. */
	static parse(): never {
		throw new Error(Translator.gettext('Not implemented yet.'));
	}

	static build(component: UnionPart[]): string {
		return component.map(part => `${phpStr(part[0])} ${phpStr(part[1])}`).join(' ');
	}
}
