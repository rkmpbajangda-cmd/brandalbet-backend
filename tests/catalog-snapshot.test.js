import test from 'node:test';
import assert from 'node:assert/strict';
import {
  syncStoredGameCatalog,
  loadStoredGameCatalog,
  clearCatalogCacheForTest,
} from '../src/game/catalog.js';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function memoryFirestore() {
  const store = new Map();

  class Snapshot {
    constructor(path) {
      this.path = path;
      this.exists = store.has(path);
    }
    data() { return clone(store.get(this.path)); }
  }

  class DocRef {
    constructor(path) { this.path = path; }
    async get() { return new Snapshot(this.path); }
    collection(name) { return new CollectionRef(`${this.path}/${name}`); }
  }

  class CollectionRef {
    constructor(path) { this.path = path; }
    doc(id) { return new DocRef(`${this.path}/${id}`); }
  }

  return {
    collection(name) { return new CollectionRef(name); },
    async getAll(...refs) { return Promise.all(refs.map(ref => ref.get())); },
    batch() {
      const ops = [];
      return {
        set(ref, value) { ops.push(['set', ref.path, clone(value)]); },
        delete(ref) { ops.push(['delete', ref.path]); },
        async commit() {
          for (const [type, path, value] of ops) {
            if (type === 'set') store.set(path, clone(value));
            else store.delete(path);
          }
        },
      };
    },
    _store: store,
  };
}

test('admin sync persists one provider fetch and member snapshot reads never call provider', async () => {
  clearCatalogCacheForTest();
  const db = memoryFirestore();
  let providerCalls = 0;
  let gameCalls = 0;
  const client = {
    providers: async () => {
      providerCalls += 1;
      return [{ provider_id: 7, provider_name: 'Provider Seven', status: 1 }];
    },
    allGames: async () => {
      gameCalls += 1;
      return [{
        provider_id: 7,
        game_code: 'slot-7',
        game_name: 'Slot Seven',
        game_image: 'https://cdn.example.test/slot-7.png',
        launch_enable: 1,
        category: 'Slots',
      }];
    },
  };

  const synced = await syncStoredGameCatalog({ client, db, now: () => 1_000_000 });
  assert.equal(synced.games.length, 1);
  assert.equal(providerCalls, 1);
  assert.equal(gameCalls, 1);

  clearCatalogCacheForTest();
  const stored = await loadStoredGameCatalog({ db, now: () => 1_001_000 });
  assert.equal(stored.games[0].gameCode, 'slot-7');
  assert.equal(stored.providers[0].providerName, 'Provider Seven');
  assert.equal(stored.snapshotStale, false);
  assert.equal(providerCalls, 1);
  assert.equal(gameCalls, 1);
  clearCatalogCacheForTest();
});

test('snapshot remains readable after seven days without an automatic provider call', async () => {
  clearCatalogCacheForTest();
  const db = memoryFirestore();
  const client = {
    providers: async () => [{ provider_id: 1, provider_name: 'One', status: 1 }],
    allGames: async () => [{ provider_id: 1, game_code: 'g1', game_name: 'Game 1', launch_enable: 1 }],
  };
  await syncStoredGameCatalog({ client, db, now: () => 10_000 });
  clearCatalogCacheForTest();
  const eightDaysLater = 10_000 + 8 * 24 * 60 * 60 * 1000;
  const stored = await loadStoredGameCatalog({ db, now: () => eightDaysLater });
  assert.equal(stored.games.length, 1);
  assert.equal(stored.snapshotStale, true);
  clearCatalogCacheForTest();
});

test('missing persistent snapshot fails closed instead of contacting provider implicitly', async () => {
  clearCatalogCacheForTest();
  const db = memoryFirestore();
  await assert.rejects(loadStoredGameCatalog({ db }), { code: 'catalog_not_initialized', statusCode: 503 });
  clearCatalogCacheForTest();
});
