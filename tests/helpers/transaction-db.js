// Serial Firestore-like test double. Not a substitute for emulator contention tests.
export function transactionDb(initial = {}) {
  let state = new Map(Object.entries(initial));
  let queue = Promise.resolve();
  let auto = 0;

  const snapshotFor = (ref, source = state) => ({
    id: ref.id,
    ref,
    exists: source.has(ref.path),
    data: () => source.get(ref.path),
  });

  const enqueue = fn => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  const applyMutation = async mutate => enqueue(async () => {
    const next = new Map(state);
    const result = await mutate(next);
    if (db.failCommit) throw new Error('simulated_commit_failure');
    state = next;
    return result;
  });

  function makeRef(collectionName, id) {
    const docId = id || 'auto-' + ++auto;
    const path = collectionName + '/' + docId;
    const ref = {
      id: docId,
      path,
      get: async () => snapshotFor(ref),
      set: async (data, options) => applyMutation(next => {
        next.set(path, options?.merge ? { ...next.get(path), ...data } : data);
      }),
      update: async data => applyMutation(next => {
        if (!next.has(path)) throw new Error('not_found');
        next.set(path, { ...next.get(path), ...data });
      }),
      delete: async () => applyMutation(next => { next.delete(path); }),
    };
    return ref;
  }

  function fieldValue(row, field) {
    return String(field).split('.').reduce((value, part) => value == null ? undefined : value[part], row);
  }

  function matches(value, operator, expected) {
    if (operator === '==') return value === expected;
    if (operator === '<') return value < expected;
    if (operator === '<=') return value <= expected;
    if (operator === '>') return value > expected;
    if (operator === '>=') return value >= expected;
    if (operator === 'in') return Array.isArray(expected) && expected.includes(value);
    if (operator === 'array-contains') return Array.isArray(value) && value.includes(expected);
    throw new Error('unsupported_query_operator:' + operator);
  }

  function makeQuery(collectionName, filters = [], ordering = [], max = null) {
    return {
      where: (field, operator, value) => makeQuery(collectionName, [...filters, { field, operator, value }], ordering, max),
      orderBy: (field, direction = 'asc') => makeQuery(collectionName, filters, [...ordering, { field, direction }], max),
      limit: value => makeQuery(collectionName, filters, ordering, value),
      get: async () => {
        const prefix = collectionName + '/';
        let rows = [...state.entries()]
          .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
          .map(([path, data]) => ({ ref: makeRef(collectionName, path.slice(prefix.length)), data }));
        for (const filter of filters) {
          rows = rows.filter(item => matches(fieldValue(item.data, filter.field), filter.operator, filter.value));
        }
        if (ordering.length > 0) {
          rows.sort((a, b) => {
            for (const order of ordering) {
              const av = fieldValue(a.data, order.field);
              const bv = fieldValue(b.data, order.field);
              if (av === bv) continue;
              const comparison = av < bv ? -1 : 1;
              return String(order.direction).toLowerCase() === 'desc' ? -comparison : comparison;
            }
            return 0;
          });
        }
        if (Number.isInteger(max)) rows = rows.slice(0, max);
        const docs = rows.map(item => snapshotFor(item.ref));
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
  }

  const db = {
    failCommit: false,
    collection: name => ({
      doc: id => makeRef(name, id),
      where: (field, operator, value) => makeQuery(name).where(field, operator, value),
      orderBy: (field, direction) => makeQuery(name).orderBy(field, direction),
      limit: value => makeQuery(name).limit(value),
      get: () => makeQuery(name).get(),
    }),
    getAll: async (...refs) => refs.map(ref => snapshotFor(ref)),
    read: path => state.get(path),
    entries: () => [...state.entries()],
    batch: () => {
      const operations = [];
      return {
        create: (ref, data) => operations.push({ type: 'create', ref, data }),
        set: (ref, data, options) => operations.push({ type: 'set', ref, data, options }),
        update: (ref, data) => operations.push({ type: 'update', ref, data }),
        delete: ref => operations.push({ type: 'delete', ref }),
        commit: () => applyMutation(next => {
          for (const op of operations) {
            if (op.type === 'create') {
              if (next.has(op.ref.path)) throw new Error('already_exists');
              next.set(op.ref.path, op.data);
            } else if (op.type === 'set') {
              next.set(op.ref.path, op.options?.merge ? { ...next.get(op.ref.path), ...op.data } : op.data);
            } else if (op.type === 'update') {
              if (!next.has(op.ref.path)) throw new Error('not_found');
              next.set(op.ref.path, { ...next.get(op.ref.path), ...op.data });
            } else if (op.type === 'delete') {
              next.delete(op.ref.path);
            }
          }
          return operations.map(() => ({}));
        }),
      };
    },
    runTransaction: fn => enqueue(async () => {
      const next = new Map(state);
      let wrote = false;
      const tx = {
        get: async ref => {
          if (wrote) throw new Error('read_after_write');
          return snapshotFor(ref, next);
        },
        getAll: async (...refs) => {
          if (wrote) throw new Error('read_after_write');
          return refs.map(ref => snapshotFor(ref, next));
        },
        create: (ref, data) => {
          if (next.has(ref.path)) throw new Error('already_exists');
          wrote = true;
          next.set(ref.path, data);
        },
        update: (ref, data) => {
          if (!next.has(ref.path)) throw new Error('not_found');
          wrote = true;
          next.set(ref.path, { ...next.get(ref.path), ...data });
        },
        set: (ref, data, options) => {
          wrote = true;
          next.set(ref.path, options?.merge ? { ...next.get(ref.path), ...data } : data);
        },
        delete: ref => {
          wrote = true;
          next.delete(ref.path);
        },
      };
      const result = await fn(tx);
      if (db.failCommit) throw new Error('simulated_commit_failure');
      state = next;
      return result;
    }),
  };

  return db;
}
