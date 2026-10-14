import { assertJsonPath, jsonPathForPredicatePrefix } from './identifiers';
import type { OracleVectorFilter } from './types';

// Filter compilation returns SQL plus binds so callers never interpolate user metadata values.
export type FilterMatch = 'filtered' | 'match-all' | 'match-none';

export interface SqlFragment {
  sql: string;
  binds: Record<string, unknown>;
  match: FilterMatch;
}

// Bind names are generated locally to keep nested logical operators composable.
class BindCollector {
  private index = 0;
  readonly binds: Record<string, unknown> = {};

  add(value: unknown): string {
    const name = `b${this.index++}`;
    this.binds[name] = normalizeBindValue(value);
    return name;
  }
}

// Converts Mastra metadata filters into Oracle JSON_VALUE/JSON_EXISTS predicates.
export function buildMetadataWhereClause(filter?: OracleVectorFilter): SqlFragment {
  if (!filter || Object.keys(filter).length === 0) {
    return { sql: '', binds: {}, match: 'match-all' };
  }

  const collector = new BindCollector();
  const sql = buildNode(filter, collector);
  return { sql: sql ? `WHERE ${sql}` : '', binds: collector.binds, match: classifyNode(filter) };
}

function classifyNode(node: unknown): FilterMatch {
  const matches: FilterMatch[] = [];
  for (const [key, value] of Object.entries(assertPlainObject(node, 'filter'))) {
    if (key === '$and') matches.push(combineMatches(asFilterList(value, key).map(classifyNode), 'and'));
    else if (key === '$or') matches.push(combineMatches(asFilterList(value, key).map(classifyNode), 'or'));
    else if (key === '$nor')
      matches.push(invertMatch(combineMatches(asFilterList(value, key).map(classifyNode), 'or')));
    else if (key === '$not') matches.push(invertMatch(classifyNode(assertPlainObject(value, '$not'))));
    else matches.push(classifyField(value));
  }
  return combineMatches(matches, 'and');
}

function classifyField(value: unknown): FilterMatch {
  if (Array.isArray(value)) return value.length === 0 ? 'match-none' : 'filtered';
  if (!isPlainObject(value)) return 'filtered';
  const entries = Object.entries(value);
  const operators = entries.filter(([key]) => key.startsWith('$'));
  if (operators.length === 0)
    return combineMatches(
      entries.map(([, nested]) => classifyField(nested)),
      'and',
    );
  return combineMatches(
    operators.map(([operator, operand]) => classifyOperator(operator, operand)),
    'and',
  );
}

function classifyOperator(operator: string, value: unknown): FilterMatch {
  switch (operator) {
    case '$in':
    case '$all':
      return (Array.isArray(value) ? value : [value]).length === 0 ? 'match-none' : 'filtered';
    case '$nin':
      return (Array.isArray(value) ? value : [value]).length === 0 ? 'match-all' : 'filtered';
    case '$contains':
      return Array.isArray(value) && value.length === 0 ? 'match-all' : 'filtered';
    case '$not': {
      const nested = assertPlainObject(value, '$not');
      const matches = Object.entries(nested).map(([key, operand]) =>
        key.startsWith('$') ? classifyOperator(key, operand) : classifyField(operand),
      );
      return invertMatch(combineMatches(matches, 'and'));
    }
    case '$elemMatch': {
      const nested = assertPlainObject(value, '$elemMatch');
      const matches = Object.entries(nested).map(([key, operand]) => {
        if (key.startsWith('$')) return classifyOperator(key, operand);
        return isPlainObject(operand) ? classifyField(operand) : 'filtered';
      });
      return combineMatches(matches, 'and') === 'match-none' ? 'match-none' : 'filtered';
    }
    default:
      return 'filtered';
  }
}

function combineMatches(matches: FilterMatch[], operator: 'and' | 'or'): FilterMatch {
  if (operator === 'and') {
    if (matches.includes('match-none')) return 'match-none';
    if (matches.every(match => match === 'match-all')) return 'match-all';
    return 'filtered';
  }
  if (matches.includes('match-all')) return 'match-all';
  if (matches.every(match => match === 'match-none')) return 'match-none';
  return 'filtered';
}

function invertMatch(match: FilterMatch): FilterMatch {
  return match === 'match-all' ? 'match-none' : match === 'match-none' ? 'match-all' : 'filtered';
}

function asFilterList(value: unknown, operator: string): unknown[] {
  return Array.isArray(value) ? value : [assertPlainObject(value, operator)];
}

function buildNode(node: unknown, collector: BindCollector): string {
  if (!isPlainObject(node)) {
    throw new Error('Vector metadata filter must be an object');
  }

  const expressions: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      expressions.push(buildLogicalOperator(key, value, collector));
      continue;
    }
    if (key === '$not') {
      expressions.push(`NOT (${buildNode(assertPlainObject(value, '$not'), collector)})`);
      continue;
    }
    if (key.startsWith('$')) {
      throw new Error(`Unsupported root filter operator: ${key}`);
    }
    expressions.push(buildFieldExpression(key, value, collector));
  }

  return expressions.length ? expressions.map(expr => `(${expr})`).join(' AND ') : '';
}

// Logical operators intentionally accept a single object for ergonomic parity with other providers.
function buildLogicalOperator(operator: '$and' | '$or' | '$nor', value: unknown, collector: BindCollector): string {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    return operator === '$or' ? '1 = 0' : '1 = 1';
  }

  const joiner = operator === '$and' ? ' AND ' : ' OR ';
  const expression = values.map(item => `(${buildNode(assertPlainObject(item, operator), collector)})`).join(joiner);
  return operator === '$nor' ? `NOT (${expression})` : expression;
}

// Plain nested objects are treated as dotted metadata paths, not opaque JSON object comparisons.
function buildFieldExpression(path: string, value: unknown, collector: BindCollector): string {
  if (value instanceof RegExp) {
    return buildRegexExpression(path, value, '', collector);
  }

  if (Array.isArray(value)) {
    return buildOperatorExpression(path, '$in', value, collector);
  }

  if (!isPlainObject(value)) {
    return buildOperatorExpression(path, '$eq', value, collector);
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new Error(`Vector metadata filter for "${path}" cannot be an empty object`);
  }

  const operatorEntries = entries.filter(([key]) => key.startsWith('$'));
  if (operatorEntries.length === 0) {
    return entries
      .map(([nestedKey, nestedValue]) => buildFieldExpression(`${path}.${nestedKey}`, nestedValue, collector))
      .map(expr => `(${expr})`)
      .join(' AND ');
  }

  if (operatorEntries.length < entries.length) {
    throw new Error(`Unsupported mixed operator/nested-field filter for "${path}"`);
  }

  return buildFieldEntryExpressions(path, operatorEntries, collector)
    .map(expr => `(${expr})`)
    .join(' AND ');
}

// $options modifies its sibling $regex without replacing any other field conditions.
function buildFieldEntryExpressions(path: string, entries: [string, unknown][], collector: BindCollector): string[] {
  const optionsEntry = entries.find(([operator]) => operator === '$options');
  let options = '';
  if (optionsEntry) {
    if (!entries.some(([operator]) => operator === '$regex')) {
      throw new Error('$options requires $regex');
    }
    if (typeof optionsEntry[1] !== 'string') {
      throw new Error('$options requires a string of regex flags');
    }
    options = optionsEntry[1];
  }

  return entries
    .filter(([operator]) => operator !== '$options')
    .map(([operator, operand]) => {
      if (!operator.startsWith('$')) {
        return buildFieldExpression(`${path}.${operator}`, operand, collector);
      }
      if (operator === '$regex') {
        return buildRegexExpression(path, operand, options, collector);
      }
      return buildOperatorExpression(path, operator, operand, collector);
    });
}

function buildOperatorExpression(path: string, operator: string, value: unknown, collector: BindCollector): string {
  switch (operator) {
    case '$eq':
      if (value === null) return buildNullComparisonExpression(path, false);
      return `${jsonValue(path, value)} = ${bind(collector, value)}`;
    case '$ne':
      if (value === null) return buildNullComparisonExpression(path, true);
      return `${jsonValue(path, value)} <> ${bind(collector, value)}`;
    case '$gt':
      return buildRangeExpression(path, '>', value, collector);
    case '$gte':
      return buildRangeExpression(path, '>=', value, collector);
    case '$lt':
      return buildRangeExpression(path, '<', value, collector);
    case '$lte':
      return buildRangeExpression(path, '<=', value, collector);
    case '$in':
      return buildInExpression(path, value, collector, false);
    case '$nin':
      return buildInExpression(path, value, collector, true);
    case '$all':
      return buildAllExpression(path, value, collector);
    case '$elemMatch':
      return buildElemMatchExpression(path, value, collector);
    case '$exists':
      return value
        ? `JSON_EXISTS(metadata, '${assertJsonPath(path)}')`
        : `NOT JSON_EXISTS(metadata, '${assertJsonPath(path)}')`;
    case '$regex':
      return buildRegexExpression(path, value, '', collector);
    case '$contains':
      return buildContainsExpression(path, value, collector);
    case '$size':
      return buildSizeExpression(path, value, collector);
    case '$not':
      return `NOT (${buildNestedNotExpression(path, value, collector)})`;
    default:
      throw new Error(`Unsupported metadata filter operator: ${operator}`);
  }
}

function buildRangeExpression(
  path: string,
  symbol: '>' | '>=' | '<' | '<=',
  value: unknown,
  collector: BindCollector,
): string {
  const scalar = jsonValue(path, value);
  // Restrict numeric ranges to JSON numbers without coercing strings or booleans.
  // Incompatible values remain NULL, including under root or field-level NOT.
  const expression =
    typeof value === 'number'
      ? `(CASE WHEN JSON_EXISTS(metadata, '${assertJsonPath(path)}?(@.type() == "number")') THEN ${scalar} ELSE NULL END)`
      : scalar;
  return `${expression} ${symbol} ${bind(collector, value)}`;
}

function buildNullComparisonExpression(path: string, negate: boolean): string {
  const jsonPath = assertJsonPath(path);
  const exists = `JSON_EXISTS(metadata, '${jsonPath}')`;
  // Scalar extraction also returns SQL NULL for arrays, objects, and empty strings.
  // type() checks the value itself, including arrays containing null.
  const isNull = `JSON_EXISTS(metadata, '${jsonPath}?(@.type() == "null")')`;
  return negate ? `(${exists} AND NOT ${isNull})` : `(NOT ${exists} OR ${isNull})`;
}

// $not can wrap either operators or nested field expressions.
function buildNestedNotExpression(path: string, value: unknown, collector: BindCollector): string {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw new Error('$not requires a non-empty object');
  }
  return buildFieldEntryExpressions(path, Object.entries(value), collector).join(' AND ');
}

// Scalar IN checks are paired with array containment to match document-store semantics.
function buildInExpression(path: string, value: unknown, collector: BindCollector, negate: boolean): string {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    return negate ? '1 = 1' : '1 = 0';
  }

  const placeholders = values.map(item => bind(collector, item)).join(', ');
  const scalarExpression = `${jsonValue(path, values[0])} ${negate ? 'NOT ' : ''}IN (${placeholders})`;
  const arrayExpressions = values.map(item => jsonArrayContains(path, item, collector));
  const arrayExpression = arrayExpressions.length ? arrayExpressions.join(' OR ') : '1 = 0';
  if (!negate) return `(${scalarExpression} OR ${arrayExpression})`;

  // JSON_VALUE returns SQL NULL for arrays. Bypass the scalar NOT IN check for
  // arrays, including empty ones, while retaining scalar null/missing behavior.
  // CASE also avoids evaluating the scalar comparison's binds for array values.
  const isArray = `JSON_EXISTS(metadata, '${assertJsonPath(path)}?(@.type() == "array")')`;
  return `(CASE WHEN ${isArray} THEN 1 WHEN ${scalarExpression} THEN 1 ELSE 0 END = 1 AND NOT (${arrayExpression}))`;
}

function buildAllExpression(path: string, value: unknown, collector: BindCollector): string {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return '1 = 0';
  return values.map(item => jsonArrayContains(path, item, collector)).join(' AND ');
}

// Element predicates use PASSING binds because Oracle JSON path variables cannot be standard SQL binds.
function buildElemMatchExpression(path: string, value: unknown, collector: BindCollector): string {
  if (!isPlainObject(value)) {
    throw new Error('$elemMatch requires an object with conditions');
  }

  const passing: string[] = [];
  const conditions = Object.entries(value).map(([fieldOrOperator, operand]) => {
    if (fieldOrOperator.startsWith('$')) {
      return elemMatchCondition('@', fieldOrOperator, operand, collector, passing);
    }

    const nestedPath = jsonPathForPredicatePrefix(fieldOrOperator);

    if (isPlainObject(operand)) {
      return Object.entries(operand)
        .map(([operator, operatorOperand]) =>
          elemMatchCondition(nestedPath, operator, operatorOperand, collector, passing),
        )
        .join(' && ');
    }

    return elemMatchCondition(nestedPath, '$eq', operand, collector, passing);
  });

  return `JSON_EXISTS(metadata, '${assertJsonPath(path)}[*]?(${conditions.join(' && ')})'${passing.length ? ` PASSING ${passing.join(', ')}` : ''})`;
}

// Each element match operand gets its own JSON path variable for predictable bind ordering.
function elemMatchCondition(
  jsonPathPrefix: string,
  operator: string,
  value: unknown,
  collector: BindCollector,
  passing: string[],
): string {
  const jsonPathBind = (item: unknown): string => {
    const variable = collector.add(item);
    passing.push(`:${variable} AS "${variable}"`);
    return `$${variable}`;
  };

  switch (operator) {
    case '$eq':
      return `${jsonPathPrefix} == ${jsonPathBind(value)}`;
    case '$ne':
      return `${jsonPathPrefix} != ${jsonPathBind(value)}`;
    case '$gt':
      return `${jsonPathPrefix} > ${jsonPathBind(value)}`;
    case '$gte':
      return `${jsonPathPrefix} >= ${jsonPathBind(value)}`;
    case '$lt':
      return `${jsonPathPrefix} < ${jsonPathBind(value)}`;
    case '$lte':
      return `${jsonPathPrefix} <= ${jsonPathBind(value)}`;
    case '$in': {
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0) return 'false';
      return `(${values.map(item => `${jsonPathPrefix} == ${jsonPathBind(item)}`).join(' || ')})`;
    }
    case '$nin': {
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0) return 'true';
      return `(${values.map(item => `${jsonPathPrefix} != ${jsonPathBind(item)}`).join(' && ')})`;
    }
    default:
      throw new Error(`Unsupported $elemMatch operator: ${operator}`);
  }
}

// Bind Oracle regex syntax separately from the validated, translated match parameters.
function buildRegexExpression(path: string, value: unknown, options: string, collector: BindCollector): string {
  if (typeof value !== 'string' && !(value instanceof RegExp)) {
    throw new Error('$regex requires a string or RegExp');
  }

  let pattern = value instanceof RegExp ? value.source : value;
  let flags = value instanceof RegExp ? value.flags + options : options;
  // Preserve the existing (?i) shorthand and combine it with explicit options.
  if (pattern.startsWith('(?i)')) {
    pattern = pattern.slice(4);
    flags += 'i';
  }

  const unsupportedFlags = [...new Set(flags.split('').filter(flag => !'ims'.includes(flag)))];
  if (unsupportedFlags.length) {
    throw new Error(`Unsupported regex flags: ${unsupportedFlags.join('')}; supported flags are i, m, and s`);
  }

  // Oracle's n corresponds to s. Explicit c keeps the default independent of collation.
  const matchParameter = `${flags.includes('i') ? 'i' : 'c'}${flags.includes('m') ? 'm' : ''}${flags.includes('s') ? 'n' : ''}`;
  const name = collector.add(pattern);
  return `REGEXP_LIKE(${jsonValue(path, '')}, :${name}, '${matchParameter}')`;
}

// String contains uses LIKE, while structured contains compares serialized JSON.
function buildContainsExpression(path: string, value: unknown, collector: BindCollector): string {
  if (Array.isArray(value)) {
    // Keep contains' empty-list behavior independent of all's match-none semantics.
    if (value.length === 0) return '1 = 1';
    // Oracle can wrap scalars for [*] paths. Require a stored array only here;
    // the boolean guard also makes non-arrays match a negated contains filter.
    const isArray = `JSON_EXISTS(metadata, '${assertJsonPath(path)}?(@.type() == "array")')`;
    return `(${isArray} AND (${buildAllExpression(path, value, collector)}))`;
  }
  if (typeof value === 'string') {
    const scalarVariable = collector.add(escapeLikePattern(value.toLowerCase()));
    const arrayVariable = collector.add(value);
    return `(${[
      `LOWER(${jsonValue(path, '')}) LIKE '%' || :${scalarVariable} || '%' ESCAPE '\\'`,
      `JSON_EXISTS(metadata, '${assertJsonPath(path)}[*]?(@ == $${arrayVariable})' PASSING :${arrayVariable} AS "${arrayVariable}")`,
    ].join(' OR ')})`;
  }

  const variable = collector.add(JSON.stringify(value));
  return `JSON_SERIALIZE(JSON_QUERY(metadata, '${assertJsonPath(path)}' RETURNING CLOB NULL ON ERROR) RETURNING VARCHAR2(4000)) = :${variable}`;
}

function buildSizeExpression(path: string, value: unknown, collector: BindCollector): string {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error('$size requires a non-negative integer');
  }
  const variable = collector.add(value);
  // Oracle size() returns 1 for scalars and objects, so require an actual array.
  return `JSON_EXISTS(metadata, '${assertJsonPath(path)}?(@.type() == "array" && @.size() == $${variable})' PASSING :${variable} AS "${variable}")`;
}

// Oracle needs explicit return types so numeric comparisons do not fall back to string ordering.
function jsonValue(path: string, comparisonValue: unknown): string {
  const jsonPath = assertJsonPath(path);
  if (typeof comparisonValue === 'number') {
    return `JSON_VALUE(metadata, '${jsonPath}' RETURNING NUMBER NULL ON ERROR)`;
  }
  return `JSON_VALUE(metadata, '${jsonPath}' RETURNING VARCHAR2(4000) NULL ON ERROR)`;
}

function jsonArrayContains(path: string, value: unknown, collector: BindCollector): string {
  const variable = collector.add(value);
  return `JSON_EXISTS(metadata, '${assertJsonPath(path)}[*]?(@ == $${variable})' PASSING :${variable} AS "${variable}")`;
}

function bind(collector: BindCollector, value: unknown): string {
  return `:${collector.add(value)}`;
}

// JSON_VALUE returns booleans as text in this path, so normalize before binding.
function normalizeBindValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return String(value);
  return value;
}

function assertPlainObject(value: unknown, operator: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${operator} requires an object`);
  }
  if (Object.keys(value).length === 0 && operator === '$not') {
    throw new Error('$not requires a non-empty object');
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof RegExp) &&
    !(value instanceof Date)
  );
}

function escapeLikePattern(value: string): string {
  return value.replace(/([%_\\])/g, '\\$1');
}
