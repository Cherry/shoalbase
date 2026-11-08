// Port of PhpMyAdmin\SqlParser\Core: error collection shared by the lexer and the parser.
export class Core<E extends Error = Error> {
	/** Whether errors are thrown instead of being collected. */
	strict = false;
	errors: E[] = [];

	/** Core::error(); the subclasses expose their own error() signatures that build the exception. */
	protected addError(error: E): void {
		if (this.strict) {
			throw error;
		}
		this.errors.push(error);
	}
}
