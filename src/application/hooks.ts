/**
 * Test seams for deterministic schedules. Production leaves every hook unset.
 * Hooks run outside SQLite write transactions so another connection can commit.
 */
export const lifecycleHooks: {
  afterAccountRead: (() => void | Promise<void>) | null;
  afterActivate: (() => void | Promise<void>) | null;
  afterSignatureVerified: (() => void | Promise<void>) | null;
  afterAuthorized: (() => void | Promise<void>) | null;
} = {
  afterAccountRead: null,
  afterActivate: null,
  afterSignatureVerified: null,
  afterAuthorized: null,
};

export function resetLifecycleHooks(): void {
  lifecycleHooks.afterAccountRead = null;
  lifecycleHooks.afterActivate = null;
  lifecycleHooks.afterSignatureVerified = null;
  lifecycleHooks.afterAuthorized = null;
}
