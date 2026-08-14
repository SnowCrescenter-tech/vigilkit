import { DahuaError } from './errors.js';

/**
 * A minimal, dependency-free XML element model sufficient for Dahua CGI
 * responses. Dahua `cgi-bin` endpoints return flat or shallow XML documents.
 */
export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Concatenated text of direct text children (trimmed). */
  text: string;
}

/**
 * Tolerant XML parser for Dahua CGI payloads. Handles the XML declaration,
 * comments, CDATA, self-closing tags, and text nodes. It does not resolve
 * namespaces (tags are matched by local name) and is intentionally small.
 */
export function parseXml(xml: string): XmlElement {
  const root = parseNode(xml, 0);
  if (root === null || root.next === -1) {
    throw new DahuaError('PARSE', 'Failed to parse XML: no root element');
  }
  // Re-scan to find the first element node (skipping declaration/comments).
  let node: ParsedNode | null = root;
  while (node !== null && node.kind !== 'element') {
    node = node.next === -1 ? null : parseNode(xml, node.next);
  }
  if (node === null || node.kind !== 'element') {
    throw new DahuaError('PARSE', 'Failed to parse XML: no root element found');
  }
  return node.element;
}

type ParsedNode =
  | { kind: 'element'; element: XmlElement; next: number }
  | { kind: 'declaration' | 'comment' | 'cdata' | 'text' | 'doctype'; next: number };

function parseNode(xml: string, start: number): ParsedNode | null {
  let i = start;
  while (i < xml.length && /\s/.test(xml[i]!)) i++;
  if (i >= xml.length) return null;

  const nextLt = xml.indexOf('<', i);
  if (nextLt === -1) {
    return { kind: 'text', next: -1 };
  }

  // Text node before the next tag.
  if (nextLt > i) {
    return { kind: 'text', next: nextLt };
  }

  // Tag begins at nextLt.
  if (xml.startsWith('<?', nextLt)) {
    const end = xml.indexOf('?>', nextLt);
    return { kind: 'declaration', next: end === -1 ? -1 : end + 2 };
  }
  if (xml.startsWith('<!--', nextLt)) {
    const end = xml.indexOf('-->', nextLt);
    return { kind: 'comment', next: end === -1 ? -1 : end + 3 };
  }
  if (xml.startsWith('<![CDATA[', nextLt)) {
    const end = xml.indexOf(']]>', nextLt);
    return { kind: 'cdata', next: end === -1 ? -1 : end + 3 };
  }
  if (xml.startsWith('<!DOCTYPE', nextLt) || xml.startsWith('<!doctype', nextLt)) {
    const end = xml.indexOf('>', nextLt);
    return { kind: 'doctype', next: end === -1 ? -1 : end + 1 };
  }

  // Closing tag.
  if (xml[nextLt + 1] === '/') {
    const end = xml.indexOf('>', nextLt);
    return { kind: 'text', next: end === -1 ? -1 : end + 1 };
  }

  // Opening tag. Find matching '>' respecting quoted attribute values.
  let end = nextLt + 1;
  let inQuote: string | null = null;
  while (end < xml.length) {
    const ch = xml[end]!;
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === '>') {
      break;
    }
    end++;
  }
  if (end >= xml.length) {
    return { kind: 'text', next: -1 };
  }

  const tagContent = xml.slice(nextLt + 1, end);
  const selfClosing = tagContent.endsWith('/');
  const name = /^[\s]*([^\s/>]+)/.exec(tagContent)?.[1] ?? '';

  const attributes: Record<string, string> = {};
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRe.exec(tagContent)) !== null) {
    attributes[attrMatch[1]!] = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
  }

  const element: XmlElement = { name, attributes, children: [], text: '' };

  if (selfClosing) {
    return { kind: 'element', element, next: end + 1 };
  }

  // Parse children until matching close tag.
  let cursor = end + 1;
  while (cursor < xml.length) {
    const child = parseNode(xml, cursor);
    if (child === null) break;
    if (child.kind === 'text' && child.next === -1) break;

    if (child.kind === 'element') {
      element.children.push(child.element);
      cursor = child.next;
    } else {
      cursor = child.next;
    }

    // Detect close tag for this element at the new cursor position.
    const closeStart = xml.indexOf(`</${name}`, cursor);
    if (closeStart === -1) break;
    // Ensure the close tag is a real match (not nested) and immediately after cursor.
    const probe = xml.slice(cursor, closeStart).trim();
    if (probe === '' || /^[\s]*$/.test(probe)) {
      const closeEnd = xml.indexOf('>', closeStart);
      element.text = xml.slice(end + 1, closeStart).replace(/<[^>]*>/g, '').trim();
      return { kind: 'element', element, next: closeEnd === -1 ? -1 : closeEnd + 1 };
    }
  }

  return { kind: 'element', element, next: cursor };
}

/** Returns the first child element with the given name (depth-first, one level). */
export function childByName(parent: XmlElement, name: string): XmlElement | undefined {
  return parent.children.find((c) => c.name === name);
}

/** Returns all direct child elements with the given name. */
export function childrenByName(parent: XmlElement, name: string): XmlElement[] {
  return parent.children.filter((c) => c.name === name);
}

/** Reads the text of the first direct child with the given name, or `undefined`. */
export function childText(parent: XmlElement, name: string): string | undefined {
  const child = childByName(parent, name);
  return child ? (child.text || undefined) : undefined;
}
