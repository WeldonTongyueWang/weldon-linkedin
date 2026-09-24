export const MUTATION_GUARD_BLOCKED_CODE = 'STALE_DATA_SYNC_REQUIRED';

export const isMutationGuardBlockedError = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === MUTATION_GUARD_BLOCKED_CODE,
  );
