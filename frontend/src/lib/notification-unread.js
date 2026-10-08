// A single in-memory read state is shared by the desktop and mobile buttons.
// Identity changes invalidate pending responses; nothing is persisted to storage.
export function createUnreadStore(load, { now = Date.now, ttl = 60000 } = {}) {
  let state = { owner: "", unread: false },
    checkedAt = -Infinity;
  let pending = null,
    generation = 0;
  const listeners = new Set();
  const publish = (next) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOwner(owner = "") {
      if (owner === state.owner) return;
      generation++;
      pending?.controller.abort();
      pending = null;
      checkedAt = -Infinity;
      publish({ owner, unread: false });
    },
    refresh({ force = false } = {}) {
      const owner = state.owner;
      if (!owner) return Promise.resolve();
      if (!force && pending) return pending.promise;
      if (!force && now() - checkedAt < ttl) return Promise.resolve();
      pending?.controller.abort();
      const request = {
        controller: new AbortController(),
        generation: ++generation,
      };
      // Count failed attempts too, so an offline page does not repeatedly retry.
      checkedAt = now();
      request.promise = Promise.resolve()
        .then(() => load(request.controller.signal))
        .then((unread) => {
          if (request.generation === generation && owner === state.owner)
            publish({ owner, unread: !!unread });
        })
        .catch(() => {})
        .finally(() => {
          if (pending === request) pending = null;
        });
      pending = request;
      return request.promise;
    },
  };
}
