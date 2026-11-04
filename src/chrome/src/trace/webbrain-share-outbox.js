// Research sharing is removed from this self-hosted build.
export const SHARE_OUTBOX_STORAGE_KEY = 'webbrainShareOutboxV1';
export function buildShareGenerationItem() { return null; }
export function buildShareDiagnosticItem() { return null; }
export async function enqueueShareGeneration() { return false; }
export async function enqueueShareDiagnostic() { return false; }
export async function purgeShareGenerations() {
  await globalThis.chrome?.storage?.local?.remove?.(SHARE_OUTBOX_STORAGE_KEY);
}
export async function flushShareOutbox() { return false; }
