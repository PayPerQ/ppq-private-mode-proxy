/**
 * nitro-secure-fetch — the browser transport core for the PPQ enclave.
 *
 * Combines the two reusable pieces into a single encrypting `fetch`:
 *   1. verify the enclave's AWS Nitro attestation (browser-verify.mjs) and
 *      extract its HPKE public key,
 *   2. HPKE-seal request bodies / open responses with the `ehbp` client bound to
 *      that VERIFIED key.
 *
 * If verification fails, no fetch function is returned — the caller cannot send.
 * This is exactly what the frontend's `getChatTransport('nitro')` will wrap.
 *
 * Isomorphic: runs in the browser and in Node 22 (WebCrypto + fetch globals).
 */

import { verifyAttestation, bytesToHex } from './browser-verify.mjs';
import { Identity } from 'ehbp';

/**
 * @param {{baseURL: string, expectedPcr0: string}} opts
 * @returns {Promise<{fetch: typeof fetch, hpkePublicKeyHex: string, pcrs: object}>}
 */
export async function createNitroSecureFetch({ baseURL, expectedPcr0 }) {
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const attRes = await fetch(`${baseURL}/attestation?nonce=${nonce}`);
  if (!attRes.ok) throw new Error(`attestation fetch failed: HTTP ${attRes.status}`);
  const att = await attRes.json();

  // Trust gate — throws if the enclave isn't the published, attested image.
  const { hpkePublicKeyHex, pcrs } = await verifyAttestation(att.attestation_document_b64, {
    expectedPcr0,
    nonceHex: nonce,
  });

  const identity = await Identity.fromPublicKeyHex(hpkePublicKeyHex);

  const secureFetch = async (input, init = {}) => {
    const req = new Request(input, init);
    const { request: encReq, context } = await identity.encryptRequestWithContext(req);

    const body = encReq.body ? await encReq.arrayBuffer() : undefined;
    const sent = await fetch(encReq.url, {
      method: encReq.method,
      headers: encReq.headers,
      body,
    });
    // Auth/balance errors come back as plaintext (no ehbp context) — pass through
    // so the caller sees the real status/message.
    if (!context || sent.status !== 200) return sent;
    return identity.decryptResponseWithContext(sent, context);
  };

  return { fetch: secureFetch, hpkePublicKeyHex, pcrs };
}
