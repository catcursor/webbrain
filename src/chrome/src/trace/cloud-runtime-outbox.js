// Managed-cloud runtime uploads are removed from this self-hosted build.
export const CLOUD_RUNTIME_OUTBOX_STORAGE_KEY = 'webbrainCloudRuntimeOutboxV1';
export function buildTerminalRuntimeEvent() { return null; }
export async function enqueueCloudRuntimeEvent() { return false; }
export async function flushCloudRuntimeOutbox() { return false; }
