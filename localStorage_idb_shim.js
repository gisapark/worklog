
/* WorkLog PRO localStorage -> IndexedDB shim (mobile-safe) */
(function(){
  const DB_NAME = 'WLP_LS_SHIM';
  const STORE = 'kv';

  function openDB(){
    return new Promise((resolve,reject)=>{
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if(!db.objectStoreNames.contains(STORE)){
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key){
    const db = await openDB();
    return new Promise((resolve,reject)=>{
      const tx = db.transaction(STORE,'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = ()=>resolve(r.result ?? null);
      r.onerror = ()=>reject(r.error);
    });
  }
  async function idbSet(key,val){
    const db = await openDB();
    return new Promise((resolve,reject)=>{
      const tx = db.transaction(STORE,'readwrite');
      const r = tx.objectStore(STORE).put(val,key);
      r.onsuccess = ()=>resolve(true);
      r.onerror = ()=>reject(r.error);
    });
  }
  async function idbDel(key){
    const db = await openDB();
    return new Promise((resolve,reject)=>{
      const tx = db.transaction(STORE,'readwrite');
      const r = tx.objectStore(STORE).delete(key);
      r.onsuccess = ()=>resolve(true);
      r.onerror = ()=>reject(r.error);
    });
  }

  const original = window.localStorage;
  const cache = Object.create(null);

  // preload from original localStorage into cache + IDB (one-way migration)
  (async function migrateOnce(){
    try{
      if(original){
        for(let i=0;i<original.length;i++){
          const k = original.key(i);
          const v = original.getItem(k);
          cache[k] = v;
          try{ await idbSet(k,v); }catch(_){}
        }
      }
      // also load any keys already in IDB into cache if cache missing
      try{
        const db = await openDB();
        const tx = db.transaction(STORE,'readonly');
        const store = tx.objectStore(STORE);
        const allKeys = await new Promise(res=>{
          const r = store.getAllKeys();
          r.onsuccess = ()=>res(r.result||[]);
        });
        for(const k of allKeys){
          if(cache[k] === undefined){
            try{ cache[k] = await idbGet(k); }catch(_){}
          }
        }
      }catch(_){}
    }catch(_){}
  })();

  // Replace localStorage with sync cache + async persistence
  window.localStorage = {
    getItem(key){
      return (key in cache) ? cache[key] : null;
    },
    setItem(key,val){
      cache[key] = String(val);
      idbSet(key, String(val)).catch(()=>{});
    },
    removeItem(key){
      delete cache[key];
      idbDel(key).catch(()=>{});
    },
    key(i){
      return Object.keys(cache)[i] ?? null;
    },
    get length(){
      return Object.keys(cache).length;
    },
    clear(){
      Object.keys(cache).forEach(k=>delete cache[k]);
      // best-effort: wipe IDB store
      openDB().then(db=>{
        const tx = db.transaction(STORE,'readwrite');
        tx.objectStore(STORE).clear();
      }).catch(()=>{});
    }
  };
})();
