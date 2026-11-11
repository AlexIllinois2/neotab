/* NeoTab — storage adapters.
   chrome.storage.local in the extension, localStorage when opened as a plain
   page, in-memory as the last resort. Large wallpaper data lives in IndexedDB. */
(function (global) {
  'use strict';
  const NT = global.NT;
  const memory = {};
  const blobMemory = {};

  const hasExtensionStorage = !!(NT.isExtension && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);

  /* Support both promise-based (MV3, modern Chrome) and callback-only APIs. */
  function chromeCall(method, args, pick) {
    return new Promise(function (resolve, reject) {
      try {
        const result = chrome.storage.local[method].apply(chrome.storage.local,
          args.concat([function (value) {
            if (chrome.runtime && chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(pick ? pick(value) : value);
          }]));
        if (result && typeof result.then === 'function') {
          result.then(function (value) { resolve(pick ? pick(value) : value); }, reject);
        }
      } catch (e) { reject(e); }
    });
  }

  const storage = {
    get: function (key, fallback) {
      if (hasExtensionStorage) {
        return chromeCall('get', [key], function (result) {
          return result && Object.prototype.hasOwnProperty.call(result, key) ? result[key] : fallback;
        }).catch(function () { return localGet(key, fallback); });
      }
      return Promise.resolve(localGet(key, fallback));
    },
    set: function (key, value) {
      memory[key] = value;
      const payload = {};
      payload[key] = value;
      if (hasExtensionStorage) {
        return chromeCall('set', [payload]).catch(function () { localSet(key, value); });
      }
      localSet(key, value);
      return Promise.resolve();
    },
    remove: function (key) {
      delete memory[key];
      if (hasExtensionStorage) {
        try {
          const pending = chrome.storage.local.remove(key);
          if (pending && typeof pending.catch === 'function') pending.catch(function () {});
        } catch (e) {}
      }
      try { localStorage.removeItem(key); } catch (e) {}
      return Promise.resolve();
    }
  };

  function localGet(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(memory, key)) return memory[key];
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function localSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { /* quota exceeded — memory copy still serves this session */ }
  }

  /* ---- IndexedDB for wallpaper data URLs --------------------------------- */
  const DB_NAME = 'neotab-files';
  const STORE = 'files';
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (!global.indexedDB) { resolve(null); return; }
      let request;
      try { request = indexedDB.open(DB_NAME, 1); }
      catch (e) { resolve(null); return; }
      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { resolve(null); };
    });
    return dbPromise;
  }

  const blobs = {
    get: function (name) {
      if (Object.prototype.hasOwnProperty.call(blobMemory, name)) return Promise.resolve(blobMemory[name]);
      return openDb().then(function (db) {
        if (!db) return localBlobGet(name);
        return new Promise(function (resolve) {
          const tx = db.transaction(STORE, 'readonly');
          const req = tx.objectStore(STORE).get(name);
          req.onsuccess = function () { resolve(req.result === undefined ? localBlobGet(name) : req.result); };
          req.onerror = function () { resolve(localBlobGet(name)); };
        });
      });
    },
    set: function (name, data) {
      blobMemory[name] = data;
      return openDb().then(function (db) {
        if (!db) { localBlobSet(name, data); return; }
        return new Promise(function (resolve) {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(data, name);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { localBlobSet(name, data); resolve(); };
        });
      });
    },
    remove: function (name) {
      delete blobMemory[name];
      try { localStorage.removeItem('neotab.blob.' + name); } catch (e) {}
      return openDb().then(function (db) {
        if (!db) return;
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(name);
      });
    }
  };

  function localBlobGet(name) {
    try { return localStorage.getItem('neotab.blob.' + name); }
    catch (e) { return null; }
  }
  function localBlobSet(name, data) {
    try { localStorage.setItem('neotab.blob.' + name, data); }
    catch (e) { /* too large for localStorage; IndexedDB is the primary store */ }
  }

  NT.storage = storage;
  NT.blobs = blobs;
})(window);
