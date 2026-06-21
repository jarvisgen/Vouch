// Walrus evidence store. Real integration (testnet publisher/aggregator).
//
// TODO(step 4):
//   putBundle(bundle): PUT JSON to `${publisher}/v1/blobs?epochs=N` -> { blobId }
//   getBundle(blobId): GET `${aggregator}/v1/blobs/${blobId}` -> EvidenceBundle
//   verifiableLink(blobId): aggregator URL for the UI
//   include retry + fallback endpoint (public publisher uptime is the only Walrus risk)
import type { EvidenceBundle } from "../types.js";

export async function putBundle(_bundle: EvidenceBundle): Promise<{ blobId: string }> {
  throw new Error("TODO(step 4): Walrus PUT");
}

export async function getBundle(_blobId: string): Promise<EvidenceBundle> {
  throw new Error("TODO(step 4): Walrus GET");
}
