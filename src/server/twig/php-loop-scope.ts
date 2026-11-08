// Twig's for loop ends with array_intersect_key($context, $_parent) + $_parent, but Twing keeps variables first set inside the loop.
import { type TwingNodeExecutor, executeNode } from 'twing';

/** executeNode() that drops the variables a for loop introduced, as compiled Twig templates do. */
export const phpScopedNodeExecutor: TwingNodeExecutor = async (node, executionContext) => {
	if (node.type !== 'for') {
		return executeNode(node, executionContext);
	}
	const { context } = executionContext;
	const before = new Set([...context].map(([key]) => key));
	const result: unknown = await executeNode(node, executionContext);
	for (const [key] of context) {
		if (!before.has(key)) {
			context.delete(key);
		}
	}
	return result;
};
