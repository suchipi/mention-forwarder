export type SeenIds = {
  /** Records `id` and reports whether it had already been seen. */
  sawAlready(id: string): boolean;
};

/** Drops webhook retries, which all three platforms send after a slow or failed response. */
export function createSeenIds(capacity: number): SeenIds {
  const seen = new Set<string>();
  return {
    sawAlready(id) {
      if (seen.has(id)) return true;
      seen.add(id);
      if (seen.size > capacity) {
        const oldest = seen.values().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      return false;
    },
  };
}
