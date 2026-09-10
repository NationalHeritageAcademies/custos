/**
 * A small parser for the subset of the mongosh language Custos accepts in the
 * query editor.
 *
 * Custos' editor is a text box that speaks a database's own language, so the
 * MongoDB driver takes shell syntax (`db.users.find({ age: { $gt: 30 } })`)
 * rather than raw command documents — that is what a MongoDB user already
 * types, and what every other Mongo tool shows in its docs.
 *
 * This is deliberately NOT a JavaScript engine: there are no variables, no
 * control flow, and no user-defined functions, so nothing here can execute
 * arbitrary code. A statement is a *shape* — `db.<collection>.<method>(args)`
 * plus optional cursor-chain calls — and its arguments are relaxed-JSON
 * literals (unquoted keys, single quotes, trailing commas, `/regex/i`, and the
 * `ObjectId(…)`-style BSON constructors the shell prints). Anything outside
 * that shape is rejected with a message rather than guessed at.
 */
import { QueryError } from '@custos/core';
import {
  Binary,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
} from 'mongodb';

/** One `.method(args)` in a cursor chain, e.g. the `.limit(10)` in `find().limit(10)`. */
export interface ChainCall {
  readonly method: string;
  readonly args: unknown[];
}

export type ShowTarget = 'databases' | 'collections';

/** A single parsed statement. `source` is the original text, for error messages. */
export type MongoStatement =
  | { readonly kind: 'use'; readonly source: string; readonly database: string }
  | { readonly kind: 'show'; readonly source: string; readonly target: ShowTarget }
  | {
      readonly kind: 'collection';
      readonly source: string;
      readonly collection: string;
      readonly method: string;
      readonly args: unknown[];
      readonly chain: ChainCall[];
    }
  | {
      readonly kind: 'database';
      readonly source: string;
      readonly method: string;
      readonly args: unknown[];
      readonly chain: ChainCall[];
    };

function syntaxError(message: string): QueryError {
  return new QueryError(message);
}

// --- Lexical pre-pass: comments, statement splitting ------------------------

/** True when a `/` at this point starts a regex literal rather than division. */
function regexAllowedAfter(prev: string): boolean {
  return prev === '' || '([{,;:=!&|?+-*%~^<>'.includes(prev);
}

/**
 * Strip `//` and block comments, preserving string and regex literals. Used
 * before splitting so a `;` or newline inside a comment cannot end a statement.
 */
export function stripComments(source: string): string {
  let out = '';
  let prev = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '"' || ch === "'") {
      const end = scanStringEnd(source, i);
      out += source.slice(i, end);
      i = end - 1;
      prev = ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++; // land on '/', the loop's i++ steps past it
      out += ' ';
      continue;
    }
    if (ch === '/' && regexAllowedAfter(prev)) {
      const end = scanRegexEnd(source, i);
      out += source.slice(i, end);
      i = end - 1;
      prev = '/';
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) prev = ch;
  }
  return out;
}

/** Index just past the string literal starting at `start`. */
function scanStringEnd(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  throw syntaxError('Unterminated string literal.');
}

/** Index just past the regex literal (including flags) starting at `start`. */
function scanRegexEnd(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') throw syntaxError('Unterminated regular expression literal.');
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      i++;
      while (i < source.length && /[a-z]/i.test(source[i]!)) i++;
      return i;
    }
    i++;
  }
  throw syntaxError('Unterminated regular expression literal.');
}

/**
 * Split a batch into statements on top-level `;` and newlines, the way the
 * shell does. A newline inside brackets continues the statement, and so does a
 * newline followed by `.` — that is a chained cursor call:
 *
 * ```
 * db.users.find({ active: true })
 *   .sort({ name: 1 })
 * ```
 */
export function splitStatements(source: string): string[] {
  const src = stripComments(source);
  const statements: string[] = [];
  let current = '';
  let depth = 0;

  const flush = (): void => {
    if (current.trim()) statements.push(current.trim());
    current = '';
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;

    if (ch === '"' || ch === "'") {
      const end = scanStringEnd(src, i);
      current += src.slice(i, end);
      i = end - 1;
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);

    if (ch === ';' && depth === 0) {
      flush();
      continue;
    }
    if (ch === '\n' && depth === 0 && current.trim() && !continuesOnNextLine(src, i)) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return statements;
}

/** True when the line after `newlineIndex` continues the current statement. */
function continuesOnNextLine(src: string, newlineIndex: number): boolean {
  for (let i = newlineIndex + 1; i < src.length; i++) {
    const ch = src[i]!;
    if (/\s/.test(ch)) continue;
    return ch === '.' || ch === ')' || ch === ']' || ch === '}' || ch === ',';
  }
  return false;
}

// --- Statement parsing ------------------------------------------------------

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/y;

/** Cursor over one statement's text. */
class Reader {
  index = 0;
  constructor(readonly text: string) {}

  skipSpace(): void {
    while (this.index < this.text.length && /\s/.test(this.text[this.index]!)) this.index++;
  }
  peek(): string {
    this.skipSpace();
    return this.text[this.index] ?? '';
  }
  eat(ch: string): boolean {
    if (this.peek() === ch) {
      this.index++;
      return true;
    }
    return false;
  }
  expect(ch: string): void {
    if (!this.eat(ch)) {
      throw syntaxError(`Expected "${ch}" at position ${this.index} of: ${this.text}`);
    }
  }
  identifier(): string {
    this.skipSpace();
    IDENT.lastIndex = this.index;
    const match = IDENT.exec(this.text);
    if (!match) throw syntaxError(`Expected a name at position ${this.index} of: ${this.text}`);
    this.index = IDENT.lastIndex;
    return match[0];
  }
  atEnd(): boolean {
    this.skipSpace();
    return this.index >= this.text.length;
  }
}

/** Parse every statement in a batch. */
export function parseBatch(source: string): MongoStatement[] {
  return splitStatements(source).map(parseStatement);
}

/** Parse one statement. Throws {@link QueryError} on anything unsupported. */
export function parseStatement(text: string): MongoStatement {
  const trimmed = stripComments(text).trim();

  const use = /^use\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_$.-]+))\s*;?$/.exec(trimmed);
  if (use) {
    return { kind: 'use', source: trimmed, database: (use[1] ?? use[2] ?? use[3])! };
  }

  const show = /^show\s+([a-z]+)\s*;?$/i.exec(trimmed);
  if (show) {
    const word = show[1]!.toLowerCase();
    if (word === 'dbs' || word === 'databases') {
      return { kind: 'show', source: trimmed, target: 'databases' };
    }
    if (word === 'collections' || word === 'tables') {
      return { kind: 'show', source: trimmed, target: 'collections' };
    }
    throw syntaxError(`Unsupported "show ${word}". Custos supports "show dbs" and "show collections".`);
  }

  const reader = new Reader(trimmed);
  const root = reader.identifier();
  if (root !== 'db') {
    throw syntaxError(
      `Statements must start with "db", "use", or "show" — got "${root}". ` +
        'Custos runs MongoDB shell statements, not arbitrary JavaScript.',
    );
  }

  reader.expect('.');
  let collection: string | null = null;
  let name = reader.identifier();

  // `db.getCollection("orders 2024")` — the escape hatch for collection names
  // that are not valid identifiers.
  if (name === 'getCollection' && reader.peek() === '(') {
    reader.expect('(');
    const nameArgs = parseArguments(reader);
    if (typeof nameArgs[0] !== 'string') {
      throw syntaxError('getCollection() takes the collection name as a string.');
    }
    collection = nameArgs[0];
    reader.expect('.');
    name = reader.identifier();
  } else if (reader.peek() === '.') {
    // Two names before the call: `db.<collection>.<method>(…)`.
    reader.expect('.');
    collection = name;
    name = reader.identifier();
  }

  if (reader.peek() !== '(') {
    // A bare `db.users` is a collection handle, not something to run.
    throw syntaxError(`Expected a method call in: ${trimmed}`);
  }
  reader.expect('(');
  const args = parseArguments(reader);
  const chain = parseChain(reader);

  if (!reader.atEnd()) {
    throw syntaxError(`Unexpected trailing input in: ${trimmed}`);
  }

  return collection !== null
    ? { kind: 'collection', source: trimmed, collection, method: name, args, chain }
    : { kind: 'database', source: trimmed, method: name, args, chain };
}

/** Parse a comma-separated argument list; the opening `(` is already consumed. */
function parseArguments(reader: Reader): unknown[] {
  const args: unknown[] = [];
  if (reader.eat(')')) return args;
  for (;;) {
    args.push(parseValue(reader));
    if (reader.eat(',')) {
      if (reader.eat(')')) return args; // trailing comma
      continue;
    }
    reader.expect(')');
    return args;
  }
}

/** Parse zero or more `.method(args)` calls following a call expression. */
function parseChain(reader: Reader): ChainCall[] {
  const chain: ChainCall[] = [];
  while (reader.peek() === '.') {
    reader.expect('.');
    const method = reader.identifier();
    reader.expect('(');
    chain.push({ method, args: parseArguments(reader) });
  }
  return chain;
}

// --- Value parsing (relaxed JSON + shell literals) --------------------------

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** Parse a single literal from text — the value grammar on its own, for tests. */
export function parseLiteral(text: string): unknown {
  const reader = new Reader(text);
  const value = parseValue(reader);
  if (!reader.atEnd()) throw syntaxError(`Unexpected trailing input in: ${text}`);
  return value;
}

/** Parse one value literal. */
function parseValue(reader: Reader): unknown {
  const ch = reader.peek();
  if (ch === '') throw syntaxError('Unexpected end of statement; a value was expected.');
  if (ch === '{') return parseObject(reader);
  if (ch === '[') return parseArray(reader);
  if (ch === '"' || ch === "'") return parseString(reader);
  if (ch === '/') return parseRegex(reader);
  if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber(reader);
  return parseWord(reader);
}

function parseObject(reader: Reader): Record<string, unknown> {
  reader.expect('{');
  const obj: Record<string, unknown> = {};
  if (reader.eat('}')) return obj;
  for (;;) {
    const key = parseKey(reader);
    reader.expect(':');
    obj[key] = parseValue(reader);
    if (reader.eat(',')) {
      if (reader.eat('}')) return obj; // trailing comma
      continue;
    }
    reader.expect('}');
    return obj;
  }
}

function parseKey(reader: Reader): string {
  const ch = reader.peek();
  if (ch === '"' || ch === "'") return parseString(reader);
  // Unquoted keys may contain dots and dollars: { "user.name": 1, $gt: 3 }.
  reader.skipSpace();
  const rest = reader.text.slice(reader.index);
  const match = /^[A-Za-z0-9_$][A-Za-z0-9_$.\-[\]]*/.exec(rest);
  if (!match) throw syntaxError(`Expected a field name at position ${reader.index}.`);
  reader.index += match[0].length;
  return match[0];
}

function parseArray(reader: Reader): unknown[] {
  reader.expect('[');
  const arr: unknown[] = [];
  if (reader.eat(']')) return arr;
  for (;;) {
    arr.push(parseValue(reader));
    if (reader.eat(',')) {
      if (reader.eat(']')) return arr; // trailing comma
      continue;
    }
    reader.expect(']');
    return arr;
  }
}

function parseString(reader: Reader): string {
  reader.skipSpace();
  const end = scanStringEnd(reader.text, reader.index);
  const raw = reader.text.slice(reader.index + 1, end - 1);
  reader.index = end;
  return unescape(raw);
}

function unescape(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, esc: string) => {
    switch (esc[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      case 'u': return String.fromCharCode(parseInt(esc.slice(1), 16));
      case 'x': return String.fromCharCode(parseInt(esc.slice(1), 16));
      default: return esc;
    }
  });
}

function parseRegex(reader: Reader): RegExp {
  reader.skipSpace();
  const end = scanRegexEnd(reader.text, reader.index);
  const literal = reader.text.slice(reader.index, end);
  reader.index = end;
  const lastSlash = literal.lastIndexOf('/');
  const pattern = literal.slice(1, lastSlash);
  const flags = literal.slice(lastSlash + 1);
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw syntaxError(`Invalid regular expression ${literal}: ${(err as Error).message}`);
  }
}

function parseNumber(reader: Reader): number {
  reader.skipSpace();
  NUMBER.lastIndex = reader.index;
  const match = NUMBER.exec(reader.text);
  if (!match) throw syntaxError(`Invalid number at position ${reader.index}.`);
  reader.index = NUMBER.lastIndex;
  return Number(match[0]);
}

/**
 * A bare word: a keyword (`true`, `null`, …) or a BSON constructor call such as
 * `ObjectId("…")`. `new X(…)` is accepted too, since that is how the shell
 * prints some values.
 */
function parseWord(reader: Reader): unknown {
  const word = reader.identifier();
  if (word === 'new') return parseWord(reader);

  switch (word) {
    case 'true': return true;
    case 'false': return false;
    case 'null': return null;
    case 'undefined': return null;
    case 'Infinity': return Infinity;
    case 'NaN': return NaN;
    default: break;
  }

  if (reader.peek() !== '(') {
    throw syntaxError(
      `Unsupported value "${word}". Custos accepts JSON values, /regex/, and BSON ` +
        'constructors like ObjectId("…") or ISODate("…") — not expressions or variables.',
    );
  }
  reader.expect('(');
  const args = parseArguments(reader);
  return buildBsonValue(word, args);
}

/** Turn a shell constructor call into the BSON value it denotes. */
export function buildBsonValue(name: string, args: unknown[]): unknown {
  const first = args[0];
  switch (name) {
    case 'ObjectId':
    case 'ObjectID':
      return first === undefined ? new ObjectId() : new ObjectId(String(first));
    case 'ISODate':
    case 'Date':
      return first === undefined ? new Date() : new Date(first as string | number);
    case 'NumberLong':
      return Long.fromString(String(first ?? 0));
    case 'NumberInt':
      return new Int32(Number(first ?? 0));
    case 'NumberDecimal':
      return Decimal128.fromString(String(first ?? 0));
    case 'NumberDouble':
    case 'Double':
      return new Double(Number(first ?? 0));
    case 'UUID':
      return first === undefined ? new UUID() : new UUID(String(first));
    case 'BinData':
      return new Binary(Buffer.from(String(args[1] ?? ''), 'base64'), Number(first ?? 0));
    case 'Timestamp':
      return Timestamp.fromBits(Number(args[1] ?? 0), Number(first ?? 0));
    case 'MinKey':
      return new MinKey();
    case 'MaxKey':
      return new MaxKey();
    case 'RegExp':
      return new RegExp(String(first ?? ''), String(args[1] ?? ''));
    default:
      throw syntaxError(`Unsupported constructor "${name}(…)".`);
  }
}
