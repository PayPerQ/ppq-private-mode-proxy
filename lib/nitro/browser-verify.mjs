/**
 * Browser attestation verifier for the PPQ enclave (isomorphic — runs in the
 * browser and in Node 22, both via WebCrypto). This is the in-browser trust
 * check that runs BEFORE the ehbp client encrypts anything.
 *
 * It verifies the AWS Nitro attestation document and returns the enclave's HPKE
 * public key. The browser then HPKE-seals its request body to that key (via the
 * `ehbp` client), so only the genuine attested enclave can decrypt — no TLS-cert
 * pinning needed (browsers can't read the TLS cert anyway).
 *
 * Checks (mirrors the Node reference verifier client/verify.mjs):
 *   1. COSE_Sign1 signature (ES384) with the document's leaf certificate
 *   2. certificate chain up to the pinned AWS Nitro root, with basicConstraints
 *      CA:TRUE enforced on every issuer + validity windows
 *   3. nonce freshness
 *   4. PCR0 == the expected published code fingerprint
 * On success returns { hpkePublicKeyHex, pcrs }. Throws on any failure.
 */

import * as x509 from '@peculiar/x509';
import { decode as cborDecode } from 'cbor-x';

const webcrypto = globalThis.crypto;
x509.cryptoProvider.set(webcrypto);

// AWS Nitro Enclaves root G1 (self-signed). Pinned trust anchor; verified out of
// band (SHA-256 of the published zip = 8cf60e2b…). Must match the enclave's copy.
const AWS_NITRO_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYD
VQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4
MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQL
DANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEG
BSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb
48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZE
h8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkF
R+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYC
MQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPW
rfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6N
IwLz3/Y=
-----END CERTIFICATE-----`;

// ── helpers ────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
export const bytesToHex = (b) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
const b64ToBytes = (b64) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const u8 = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));
const mget = (m, k) => (m instanceof Map ? m.get(k) : m?.[k]);

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
/** CBOR head for (majorType, length). */
function cborHead(major, len) {
  const m = major << 5;
  if (len < 24) return Uint8Array.of(m | len);
  if (len < 0x100) return Uint8Array.of(m | 24, len);
  if (len < 0x10000) return Uint8Array.of(m | 25, len >> 8, len & 0xff);
  return Uint8Array.of(m | 26, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
}
/**
 * Deterministically encode the COSE Sig_structure:
 *   [ "Signature1", protected(bstr), external_aad(bstr=""), payload(bstr) ]
 * Hand-rolled so byte strings are plain CBOR bstrs (cbor-x would tag Uint8Array,
 * corrupting the signed bytes).
 */
function encodeSigStructure(protectedBytes, payloadBytes) {
  const ctxStr = enc.encode('Signature1');
  return concatBytes(
    Uint8Array.of(0x84), // array(4)
    cborHead(3, ctxStr.length), ctxStr, // text "Signature1"
    cborHead(2, protectedBytes.length), protectedBytes, // bstr protected
    Uint8Array.of(0x40), // bstr "" (empty external_aad)
    cborHead(2, payloadBytes.length), payloadBytes, // bstr payload
  );
}

async function importEcdsaP384(spkiDer) {
  return webcrypto.subtle.importKey(
    'spki',
    spkiDer,
    { name: 'ECDSA', namedCurve: 'P-384' },
    false,
    ['verify'],
  );
}

/**
 * @param {string} attestationDocB64  base64 NSM COSE_Sign1 document
 * @param {{expectedPcr0: string, nonceHex?: string}} opts
 * @returns {Promise<{hpkePublicKeyHex: string, pcrs: Record<number,string>}>}
 */
export async function verifyAttestation(attestationDocB64, opts) {
  const expectedPcr0 = (opts.expectedPcr0 || '').toLowerCase();
  if (!expectedPcr0) throw new Error('expectedPcr0 is required');

  // Parse COSE_Sign1 = [protected, unprotected, payload, signature]
  const doc = b64ToBytes(attestationDocB64);
  let cose = cborDecode(doc);
  if (cose && cose.tag === 18 && Array.isArray(cose.value)) cose = cose.value;
  if (!Array.isArray(cose) || cose.length !== 4) throw new Error('malformed COSE_Sign1');
  const [protectedBstr, , payloadBstr, signature] = cose.map((x) =>
    x && x.buffer ? u8(x) : x,
  );

  // Algorithm must be ES384 (-35)
  const hdr = cborDecode(u8(protectedBstr));
  const alg = mget(hdr, 1);
  if (alg !== -35) throw new Error(`unexpected COSE alg ${alg} (want -35/ES384)`);

  const payload = cborDecode(u8(payloadBstr));
  const leafDer = u8(mget(payload, 'certificate'));
  const leaf = new x509.X509Certificate(leafDer);

  // 1. COSE signature over Sig_structure with the leaf key (ECDSA P-384/SHA-384,
  //    raw r||s == WebCrypto's expected format).
  const sigStructure = encodeSigStructure(u8(protectedBstr), u8(payloadBstr));
  const leafKey = await importEcdsaP384(leaf.publicKey.rawData);
  const sigOk = await webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-384' },
    leafKey,
    u8(signature),
    sigStructure,
  );
  if (!sigOk) throw new Error('COSE signature invalid');

  // 2. Chain: [root, ...intermediates, leaf]. Enforce root pin, CA:TRUE on every
  //    issuer, issuer-signature links, and validity windows.
  const cabundle = (mget(payload, 'cabundle') || []).map((d) => new x509.X509Certificate(u8(d)));
  const chain = [...cabundle, leaf];
  const awsRoot = new x509.X509Certificate(AWS_NITRO_ROOT_PEM);
  const rootTp = bytesToHex(u8(await chain[0].getThumbprint('SHA-256')));
  const wantTp = bytesToHex(u8(await awsRoot.getThumbprint('SHA-256')));
  if (rootTp !== wantTp) throw new Error('chain does not root in the AWS Nitro root');

  const now = new Date();
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i];
    if (c.notBefore > now || c.notAfter < now) throw new Error(`cert ${i} outside validity`);
    if (i < chain.length - 1) {
      const bc = c.getExtension(x509.BasicConstraintsExtension);
      if (!bc || bc.ca !== true) throw new Error(`chain cert ${i} is not a CA (basicConstraints)`);
    }
    if (i > 0) {
      const okLink = await chain[i].verify({ publicKey: chain[i - 1].publicKey, signatureOnly: true });
      if (!okLink) throw new Error(`chain broken at link ${i}`);
    }
  }

  // 3. nonce freshness
  if (opts.nonceHex) {
    const dn = mget(payload, 'nonce');
    if (!dn || bytesToHex(u8(dn)) !== opts.nonceHex.toLowerCase())
      throw new Error('nonce mismatch (possible replay)');
  }

  // 4. PCR0 == expected published fingerprint
  const pcrsMap = mget(payload, 'pcrs');
  const pcr0 = bytesToHex(u8(pcrsMap instanceof Map ? pcrsMap.get(0) : pcrsMap[0]));
  if (pcr0 !== expectedPcr0)
    throw new Error(`PCR0 mismatch\n  got:      ${pcr0}\n  expected: ${expectedPcr0}`);

  // The enclave commits its HPKE public key in `public_key`.
  const hpkePublicKeyHex = bytesToHex(u8(mget(payload, 'public_key')));

  const pcrs = {};
  const src = pcrsMap instanceof Map ? pcrsMap : new Map(Object.entries(pcrsMap));
  for (const [k, v] of src) pcrs[Number(k)] = bytesToHex(u8(v));

  return { hpkePublicKeyHex, pcrs };
}
