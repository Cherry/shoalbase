// Port of PhpMyAdmin\SqlParser\Component: parse() reads a component from the tokens and build() turns it back into SQL.
import type { Parser } from './Parser.ts';
import type { TokensList } from './TokensList.ts';

export type ComponentOptions = Record<string, unknown>;

/** A component class as PHP code refers to it (`$class::parse()`, `$class::build()`). */
export interface ComponentClass {
	parse(parser: Parser, list: TokensList, options?: ComponentOptions): unknown;
	build(component: unknown, options?: ComponentOptions): string;
}

/** Every component class defines the static parse() and build() of ComponentClass. */
export abstract class Component {
	/** __toString(): string concatenation of a component builds it. */
	toString(): string {
		// eslint-disable-next-line antislop/no-chained-type-assertions -- TypeScript types this.constructor as Function, so the subclass's static side needs an explicit lookup.
		return (this.constructor as unknown as ComponentClass).build(this);
	}
}
