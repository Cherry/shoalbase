// The components by class name, for Parser::$KEYWORD_PARSERS lookups; resolved lazily so import cycles stay harmless.
import { AlterOperation } from './AlterOperation.ts';
import { Array2d } from './Array2d.ts';
import { ArrayObj } from './ArrayObj.ts';
import { CaseExpression } from './CaseExpression.ts';
import { Condition } from './Condition.ts';
import { CreateDefinition } from './CreateDefinition.ts';
import { DataType } from './DataType.ts';
import { Expression } from './Expression.ts';
import { ExpressionArray } from './ExpressionArray.ts';
import { FunctionCall } from './FunctionCall.ts';
import { GroupKeyword } from './GroupKeyword.ts';
import { IndexHint } from './IndexHint.ts';
import { IntoKeyword } from './IntoKeyword.ts';
import { JoinKeyword } from './JoinKeyword.ts';
import { Key } from './Key.ts';
import { Limit } from './Limit.ts';
import { LockExpression } from './LockExpression.ts';
import { OptionsArray } from './OptionsArray.ts';
import { OrderKeyword } from './OrderKeyword.ts';
import { ParameterDefinition } from './ParameterDefinition.ts';
import { PartitionDefinition } from './PartitionDefinition.ts';
import { Reference } from './Reference.ts';
import { RenameOperation } from './RenameOperation.ts';
import { SetOperation } from './SetOperation.ts';
import { UnionKeyword } from './UnionKeyword.ts';
import { WithKeyword } from './WithKeyword.ts';

import type { ComponentClass } from '../Component.ts';

export {
	AlterOperation, Array2d, ArrayObj, CaseExpression, Condition, CreateDefinition, DataType, Expression, ExpressionArray, FunctionCall,
	GroupKeyword, IndexHint, IntoKeyword, JoinKeyword, Key, Limit, LockExpression, OptionsArray, OrderKeyword, ParameterDefinition,
	PartitionDefinition, Reference, RenameOperation, SetOperation, UnionKeyword, WithKeyword,
};

let classes: Record<string, ComponentClass> | undefined;

export function componentClass(name: string): ComponentClass {
	classes ??= {
		AlterOperation,
		Array2d,
		ArrayObj,
		CaseExpression,
		Condition,
		CreateDefinition,
		DataType,
		Expression,
		ExpressionArray,
		FunctionCall,
		GroupKeyword,
		IndexHint,
		IntoKeyword,
		JoinKeyword,
		Key,
		Limit,
		LockExpression,
		OptionsArray,
		OrderKeyword,
		ParameterDefinition,
		PartitionDefinition,
		Reference,
		RenameOperation,
		SetOperation,
		UnionKeyword,
		WithKeyword,
	};
	const found = classes[name];
	if (found === undefined) {
		throw new Error(`Unknown component ${name}`);
	}
	return found;
}
