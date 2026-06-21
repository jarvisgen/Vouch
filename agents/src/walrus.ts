// Real Walrus testnet client (HTTP publisher/aggregator). Stores the evidence bundle,
// returns a content-addressed blob id + verifiable aggregator link.
import { env } from "./config.js";

export async function putBundle(bundle: unknown): Promise<string> {
  const body = JSON.stringify(bundle, null, 2);
  const publishers = [env.walrusPublisher, "https://publisher.walrus-testnet.walrus.space"];
  let lastErr: unknown;
  for (const base of publishers) {
    try {
      const res = await fetch(`${base}/v1/blobs?epochs=${env.walrusEpochs}`, {
        method: "PUT",
        body,
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(`walrus ${res.status}`);
      const data: any = await res.json();
      const blobId = data?.newlyCreated?.blobObject?.blobId ?? data?.alreadyCertified?.blobId;
      if (!blobId) throw new Error("no blobId in walrus response");
      return blobId;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Walrus upload failed: ${String(lastErr)}`);
}

export const evidenceLink = (blobId: string) => `${env.walrusAggregator}/v1/blobs/${blobId}`;
