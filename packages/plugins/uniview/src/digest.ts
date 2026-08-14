import { UniviewError } from './errors.js';
import { md5 } from './md5.js';

/** A parsed `WWW-Authenticate: Digest ...` challenge (RFC 7616 §3.3). */
export interface DigestChallenge {
  realm: string;
  nonce: string;
  algorithm: string;
  qop?: string;
  opaque?: string;
  stale?: boolean;
}

/**
 * Parses a Digest `WWW-Authenticate` header value into a typed challenge.
 * Throws `UniviewError('AUTH')` if the header is missing, is not Digest, or
 * lacks a required parameter.
 */
export function parseDigestChallenge(header: string | null | undefined): DigestChallenge {
  if (!header || !/^Digest\s+/i.test(header.trim())) {
    throw new UniviewError('AUTH', 'Server did not issue a Digest WWW-Authenticate challenge');
  }

  const params = new Map<string, string>();
  // Key may be bare (realm="x") or bareword; value is quoted-string or token.
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(header)) !== null) {
    params.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? '');
  }

  const realm = params.get('realm');
  const nonce = params.get('nonce');
  if (!realm || !nonce) {
    throw new UniviewError('AUTH', 'Digest challenge missing realm or nonce');
  }

  return {
    realm,
    nonce,
    algorithm: params.get('algorithm') ?? 'MD5',
    qop: params.get('qop'),
    opaque: params.get('opaque'),
    stale: params.get('stale') === 'true',
  };
}

let nonceCounter = 0;

/** Generates a random hex token using WebCrypto when available. */
function randomHex(bytes: number): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    const buf = new Uint8Array(bytes);
    cryptoObj.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let out = '';
  for (let i = 0; i < bytes * 2; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

/**
 * Computes the digest `Authorization` header value for a single request.
 * Implements RFC 7616: `qop=auth`, `qop=auth-int` (with entity hash), and the
 * legacy no-qop variant. Algorithm MD5 is supported (MD5-sess too).
 */
export function generateAuthorization(
  username: string,
  password: string,
  method: string,
  uri: string,
  challenge: DigestChallenge,
  opts?: { entityBody?: string; cnonce?: string; nc?: string },
): string {
  const cnonce = opts?.cnonce ?? randomHex(8);
  const nc =
    opts?.nc ??
    (() => {
      nonceCounter = (nonceCounter + 1) & 0xffffffff;
      return nonceCounter.toString(16).padStart(8, '0');
    })();

  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const finalHa1 =
    challenge.algorithm.toUpperCase() === 'MD5-SESS' ? md5(`${ha1}:${challenge.nonce}:${cnonce}`) : ha1;

  const qop = (challenge.qop ?? '').split(',').map((s) => s.trim())[0] ?? '';
  let ha2: string;
  if (qop === 'auth-int') {
    const body = opts?.entityBody ?? '';
    ha2 = md5(`${method}:${uri}:${md5(body)}`);
  } else {
    ha2 = md5(`${method}:${uri}`);
  }

  const response = qop
    ? md5(`${finalHa1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${finalHa1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);

  return `Digest ${parts.join(', ')}`;
}
