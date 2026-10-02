// Serial transactional test double. Not a substitute for Firestore emulator contention tests.
export function transactionDb(initial = {}) {
  let state = new Map(Object.entries(initial)); let queue = Promise.resolve(); let auto = 0;
  const db = {
    failCommit: false,
    collection: name => ({ doc: id => {
      const path = name + '/' + (id || 'auto-' + ++auto);
      return {
        path,
        get: async () => ({ exists: state.has(path), data: () => state.get(path) }),
      };
    } }),
    read: path => state.get(path),
    entries: () => [...state.entries()],
    runTransaction: fn => {
      const run = queue.then(async () => {
        const next = new Map(state); let wrote = false;
        const tx = {
          get: async ref => { if (wrote) throw new Error('read_after_write'); return { exists: next.has(ref.path), data: () => next.get(ref.path) }; },
          create: (ref, data) => { if (next.has(ref.path)) throw new Error('already_exists'); wrote = true; next.set(ref.path, data); },
          update: (ref, data) => { if (!next.has(ref.path)) throw new Error('not_found'); wrote = true; next.set(ref.path, { ...next.get(ref.path), ...data }); },
          set: (ref, data, options) => { wrote = true; next.set(ref.path, options?.merge ? { ...next.get(ref.path), ...data } : data); },
        };
        const result = await fn(tx);
        if (db.failCommit) throw new Error('simulated_commit_failure');
        state = next; return result;
      });
      queue = run.catch(() => {}); return run;
    },
  };
  return db;
}
