async function runWithIgnoredTlsErrors<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  try {
    return await work();
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  }
}

/**
 * Runs site collection with TLS verification disabled when requested.
 *
 * This toggles Node/Bun TLS verification via NODE_TLS_REJECT_UNAUTHORIZED for
 * the duration of the collection call only.
 */
export async function withOptionalTlsIgnore<T>(
  ignoreTlsErrors: boolean,
  work: () => Promise<T>,
): Promise<T> {
  if (!ignoreTlsErrors) {
    return work();
  }
  return runWithIgnoredTlsErrors(work);
}
