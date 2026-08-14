/**
 * Minimal RFC 3261 SIP message parser/serializer for GB/T 28181 signaling.
 *
 * Parses request/status lines, headers (with folding), and the message body.
 * Malformed input never throws an uncontrolled error: `parseSipMessage`
 * throws a typed `SipError` only when no start line can be extracted at all;
 * everything else is best-effort (header lines without a colon are skipped,
 * an unexpected end of headers just means an empty body).
 */

/** Typed SIP error, thrown by the parser and the session state machine. */
export class SipError extends Error {
  readonly code: 'PARSE' | 'STATE' | 'AUTH';

  constructor(code: 'PARSE' | 'STATE' | 'AUTH', message: string) {
    super(message);
    this.name = 'SipError';
    this.code = code;
  }
}

/** Convenience factory for throwing a `SipError`. */
export function sipError(code: 'PARSE' | 'STATE' | 'AUTH', message: string): SipError {
  return new SipError(code, message);
}

export interface SipRequestLine {
  method: string;
  uri: string;
  version: string;
}

export interface SipStatusLine {
  version: string;
  statusCode: number;
  reasonPhrase: string;
}

export type SipStartLine = SipRequestLine | SipStatusLine;

export interface SipHeaderField {
  name: string;
  value: string;
}

export interface SipMessage {
  startLine: SipStartLine;
  /** Headers in wire order; duplicate header names are preserved. */
  headers: SipHeaderField[];
  /** The message body (after the first empty line), or ''. */
  body: string;
}

export function isSipRequest(message: SipMessage): message is SipMessage & { startLine: SipRequestLine } {
  return 'method' in message.startLine;
}

export function isSipResponse(message: SipMessage): message is SipMessage & { startLine: SipStatusLine } {
  return 'statusCode' in message.startLine;
}

const REQUEST_LINE = /^([A-Za-z]+)\s+(\S+)\s+(SIP\/2\.0)\s*$/;
const STATUS_LINE = /^(SIP\/2\.0)\s+(\d{3})(?:\s+(.*))?$/;

/**
 * GB/T 28181 headers that use `=` instead of the RFC 3261 `:` delimiter
 * (e.g. `y=0100000001` for the SSRC, `f=v/2/5/25/1/128/0/0` for the media
 * description). Real platforms emit and expect these exactly.
 */
const EQUALS_DELIMITED_HEADERS = new Set(['y', 'f']);

/**
 * Parses a SIP message from its wire text. Throws `SipError('PARSE')` for
 * empty input or a start line that matches neither a request nor a response;
 * otherwise returns the best-effort parse (skipping unparseable header lines).
 */
export function parseSipMessage(text: string): SipMessage {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw sipError('PARSE', 'empty SIP message');
  }
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.map((line) => line.replace(/\r$/, ''));
  const startLine = parseStartLine(lines[0] ?? '');
  const headers: SipHeaderField[] = [];
  let bodyStart = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.length === 0) {
      bodyStart = i + 1;
      break;
    }
    if (line.startsWith(' ') || line.startsWith('\t')) {
      // Header folding: a continuation of the previous header value.
      const last = headers[headers.length - 1];
      if (last !== undefined) last.value += ' ' + line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      // GB/T 28181 `y=`/`f=` headers use '=' as the delimiter.
      const first = line[0] as string;
      if (line.length > 1 && line[1] === '=' && EQUALS_DELIMITED_HEADERS.has(first.toLowerCase())) {
        headers.push({ name: first, value: line.slice(2) });
      }
      continue; // best effort: skip other junk lines
    }
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  const body = bodyStart === -1 ? '' : lines.slice(bodyStart).join('\n').replace(/\n+$/, '');
  return { startLine, headers, body };
}

function parseStartLine(line: string): SipStartLine {
  const request = REQUEST_LINE.exec(line);
  if (request !== null) {
    return { method: request[1] as string, uri: request[2] as string, version: request[3] as string };
  }
  const status = STATUS_LINE.exec(line);
  if (status !== null) {
    return {
      version: status[1] as string,
      statusCode: Number(status[2]),
      reasonPhrase: status[3] ?? '',
    };
  }
  throw sipError('PARSE', `not a SIP start line: '${line}'`);
}

/** Serializes a parsed (or constructed) SIP message back to wire text. */
export function serializeSipMessage(message: SipMessage): string {
  const start =
    'method' in message.startLine
      ? `${message.startLine.method} ${message.startLine.uri} ${message.startLine.version}`
      : message.startLine.reasonPhrase.length > 0
        ? `${message.startLine.version} ${message.startLine.statusCode} ${message.startLine.reasonPhrase}`
        : `${message.startLine.version} ${message.startLine.statusCode}`;
  const headerLines = message.headers.map((header) =>
    EQUALS_DELIMITED_HEADERS.has(header.name.toLowerCase())
      ? `${header.name}=${header.value}`
      : `${header.name}: ${header.value}`,
  );
  // The trailing '' element always emits the blank separator line before the
  // body, so an empty-body message round-trips to its canonical form.
  return [start, ...headerLines, '', message.body].join('\r\n');
}

/** First header value for `name` (case-insensitive), or undefined. */
export function sipHeader(message: SipMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const header of message.headers) {
    if (header.name.toLowerCase() === lower) return header.value;
  }
  return undefined;
}

/** All header values for `name` (case-insensitive), in wire order. */
export function sipHeaders(message: SipMessage, name: string): string[] {
  const lower = name.toLowerCase();
  return message.headers.filter((header) => header.name.toLowerCase() === lower).map((header) => header.value);
}

/**
 * Parses a comma/param list such as a Via or Contact header value or a
 * Digest Authorization directive list into ordered key/value pairs. Bare
 * tokens map to `undefined` values; quoted strings are unquoted.
 */
export function parseHeaderParams(value: string): Array<{ key: string; value: string | undefined }> {
  const out: Array<{ key: string; value: string | undefined }> = [];
  const re = /(\w+)\s*(?:=\s*(?:"([^"]*)"|([^,;\s]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    if (match[1] === undefined) continue;
    out.push({ key: match[1], value: match[2] ?? match[3] });
  }
  return out;
}

export interface SipVia {
  /** e.g. 'SIP/2.0/UDP' or 'SIP/2.0/WS'. */
  protocol: string;
  /** Host part of the sent-by field (IP or hostname). */
  host: string;
  port?: number;
  params: Map<string, string>;
}

/**
 * Parses a `Via` header value: `SIP/2.0/UDP 192.168.1.10:5060;branch=z9hG4bK..;rport`.
 * Returns a best-effort parse (never throws).
 */
export function parseVia(value: string): SipVia {
  const trimmed = value.trim();
  const segments = trimmed.split(/[;,]\s*/);
  const first = segments[0] ?? '';
  const space = first.indexOf(' ');
  // The first segment holds both the protocol and the sent-by, space-separated.
  const protocol = space === -1 ? first : first.slice(0, space);
  const sentBy = space === -1 ? (segments[1] ?? '') : first.slice(space + 1).trim();
  const params = new Map<string, string>();
  const paramStart = space === -1 ? 2 : 1;
  for (let i = paramStart; i < segments.length; i++) {
    const param = segments[i] as string;
    const eq = param.indexOf('=');
    if (eq === -1) params.set(param, '');
    else params.set(param.slice(0, eq), param.slice(eq + 1));
  }
  const hostPort = sentBy.lastIndexOf(':');
  let host = sentBy;
  let port: number | undefined;
  if (hostPort !== -1 && !sentBy.includes(']')) {
    host = sentBy.slice(0, hostPort);
    const portValue = Number(sentBy.slice(hostPort + 1));
    if (Number.isInteger(portValue) && portValue > 0) port = portValue;
  }
  return { protocol, host, port, params };
}

export interface SipCSeq {
  sequence: number;
  method: string;
}

/** Parses a `CSeq` header value: `12345 INVITE`. Throws SipError on garbage. */
export function parseCSeq(value: string | undefined): SipCSeq {
  if (value === undefined) throw sipError('PARSE', 'missing CSeq header');
  const match = /^(\d+)\s+([A-Za-z]+)\s*$/.exec(value.trim());
  if (match === null) throw sipError('PARSE', `malformed CSeq: '${value}'`);
  return { sequence: Number(match[1]), method: match[2] as string };
}
