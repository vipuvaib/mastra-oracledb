import type { MastraDBMessage } from '@mastra/core/memory';
import { describe, expect, it, vi } from 'vitest';

import { listMessages, listMessagesByResourceId } from './messages';
import {
  createMessageWindowFixture,
  messageWindowCases,
  messageWindowEntryPoints,
} from './messages-include.test-fixtures';
import type { MemoryContext } from './utils';

type MessageRow = Omit<MastraDBMessage, 'content'> & { content: string };
type Predicate = (row: MessageRow) => boolean;

// Evaluate the narrow WHERE grammar emitted by window queries, including AND,
// OR and parentheses. Do not manufacture the expected tuple bounds here: the
// actual SQL must decide which rows are selected before ORDER BY and FETCH.
function windowPredicate(where: string, binds: Record<string, unknown>): Predicate {
  const tokens = where.match(/"[^"]+"|:[A-Za-z0-9_]+|<=|>=|[=<>()]|[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  let position = 0;
  const term = (): Predicate => {
    if (tokens[position] === '(') {
      position++;
      const nested = or();
      if (tokens[position++] !== ')') throw new Error(`Unbalanced window predicate: ${where}`);
      return nested;
    }
    const column = tokens[position++]?.replaceAll('"', '');
    const operator = tokens[position++];
    const placeholder = tokens[position++];
    if (!column || !operator || !placeholder?.startsWith(':')) throw new Error(`Unexpected predicate: ${where}`);
    const key = placeholder.slice(1);
    if (!(key in binds)) throw new Error(`Missing bind ${key}`);
    if (!['createdAt', 'id', 'thread_id', 'resourceId'].includes(column)) throw new Error(`Unknown column ${column}`);
    return row => {
      const field = column === 'thread_id' ? 'threadId' : column;
      const value = row[field as keyof MessageRow];
      const comparison =
        column === 'createdAt'
          ? new Date(value as Date).getTime() - new Date(binds[key] as Date).getTime()
          : String(value) === String(binds[key])
            ? 0
            : String(value) < String(binds[key])
              ? -1
              : 1;
      switch (operator) {
        case '=':
          return comparison === 0;
        case '<':
          return comparison < 0;
        case '<=':
          return comparison <= 0;
        case '>':
          return comparison > 0;
        case '>=':
          return comparison >= 0;
        default:
          throw new Error(`Unknown comparison ${operator}`);
      }
    };
  };
  const and = (): Predicate => {
    let predicate = term();
    while (tokens[position] === 'AND') {
      position++;
      const left = predicate;
      const right = term();
      predicate = row => left(row) && right(row);
    }
    return predicate;
  };
  const or = (): Predicate => {
    let predicate = and();
    while (tokens[position] === 'OR') {
      position++;
      const left = predicate;
      const right = and();
      predicate = row => left(row) || right(row);
    }
    return predicate;
  };
  const predicate = or();
  if (position !== tokens.length) throw new Error(`Unparsed window predicate: ${where}`);
  return predicate;
}

function createIncludeContext(messages: MastraDBMessage[]) {
  const stored: MessageRow[] = messages.map(message => ({ ...message, content: JSON.stringify(message.content) }));
  const execute = vi.fn(async (sql: string, binds: Record<string, unknown> = {}) => {
    if (sql.includes('WHERE id IN (')) {
      const ids = Object.entries(binds)
        .filter(([key]) => /^targetId\d+$/.test(key))
        .map(([, value]) => value);
      const resourceBind = /"resourceId" = :(\w+)/.exec(sql)?.[1];
      return {
        rows: stored.filter(row => ids.includes(row.id) && (!resourceBind || row.resourceId === binds[resourceBind])),
      };
    }
    const where = / WHERE (.+?) ORDER BY /s.exec(sql)?.[1];
    const order = /ORDER BY "createdAt" (ASC|DESC), id (ASC|DESC)/.exec(sql);
    const limit = /FETCH FIRST (\d+) ROWS ONLY/.exec(sql)?.[1];
    if (!where || !order || !limit) throw new Error(`Unexpected include SQL: ${sql}`);
    const selected = stored.filter(windowPredicate(where, binds));
    selected.sort((a, b) => {
      const byTime = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (byTime) return order[1] === 'ASC' ? byTime : -byTime;
      const byId = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      return order[2] === 'ASC' ? byId : -byId;
    });
    return { rows: selected.slice(0, Number(limit)) };
  });
  const connection = { execute };
  const ctx = {
    db: { withConnection: async <T>(callback: (client: typeof connection) => Promise<T>) => callback(connection) },
    validatePaginationInput: vi.fn(),
    parseOrderBy: () => ({ field: 'createdAt', direction: 'ASC' }),
  } as unknown as MemoryContext;
  return { ctx, execute };
}

describe.each(messageWindowEntryPoints)('Oracle message include timestamp ties: %s', entryPoint => {
  it.each(messageWindowCases)('$name', async testCase => {
    const fixture = createMessageWindowFixture(testCase);
    const { ctx, execute } = createIncludeContext(fixture.messages);
    const { threadId, ...resourceQuery } = fixture.query;
    const result =
      entryPoint === 'thread'
        ? await listMessages(ctx, { threadId, ...resourceQuery })
        : await listMessagesByResourceId(ctx, resourceQuery);

    expect(result.messages.map(message => message.id)).toEqual(fixture.expectedIds);
    expect(result).toMatchObject({ total: 0, page: 0, perPage: 0, hasMore: false });
    expect(new Set(result.messages.map(message => message.id)).size).toBe(result.messages.length);
    // Include-only results must not be rescued by an ordinary primary page.
    expect(execute.mock.calls.some(([sql]) => sql.includes('COUNT(*)') || sql.includes('OFFSET'))).toBe(false);
  });
});
