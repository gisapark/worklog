
/* WorkLog PRO Backup/Restore (LocalStorage + IndexedDB, transaction-safe) */
(function(global){
  const APP = global.APP || (global.APP = {});

  function openDB(dbName){
    return new Promise((resolve, reject)=>{
      const r = indexedDB.open(dbName);
      r.onsuccess = e => resolve(e.target.result);
      r.onerror = () => reject(r.error);
    });
  }

  function txDone(tx){
    return new Promise((resolve, reject)=>{
      tx.oncomplete = ()=>resolve(true);
      tx.onerror = ()=>reject(tx.error);
      tx.onabort = ()=>reject(tx.error);
    });
  }

  async function dumpIndexedDB(){
    const dump = {};
    const dbs = await indexedDB.databases();
    for(const info of dbs){
      if(!info.name) continue;
      const db = await openDB(info.name);
      dump[info.name] = {};
      for(const storeName of db.objectStoreNames){
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const data = await new Promise((resolve, reject)=>{
          const r = store.getAll();
          r.onsuccess = ()=>resolve(r.result || []);
          r.onerror = ()=>reject(r.error);
        });
        await txDone(tx);
        dump[info.name][storeName] = data;
      }
      try{ db.close(); }catch(_){}
    }
    return dump;
  }

  function dumpLocalStorage(){
    const out = {};
    try{
      for(let i=0;i<localStorage.length;i++){
        const k = localStorage.key(i);
        out[k] = localStorage.getItem(k);
      }
    }catch(_){}
    return out;
  }

  APP.exportBackup = async function(){
    const payload = {
      meta: {
        app: 'WorkLog PRO',
        format: 'WLP_BACKUP_V2',
        exportedAt: new Date().toISOString()
      },
      localStorage: dumpLocalStorage(),
      indexedDB: await dumpIndexedDB()
    };

    const blob = new Blob([JSON.stringify(payload,null,2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'WorkLogPRO_Backup.json';
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1500);
  };

  async function restoreIndexedDB(dump){
    for(const [dbName, stores] of Object.entries(dump || {})){
      const db = await openDB(dbName);
      for(const [storeName, records] of Object.entries(stores || {})){
        if(!db.objectStoreNames.contains(storeName)) continue;
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);

        // clear first and wait
        await new Promise((resolve, reject)=>{
          const r = store.clear();
          r.onsuccess = ()=>resolve(true);
          r.onerror = ()=>reject(r.error);
        });

        for(const rec of (records || [])){
          await new Promise((resolve, reject)=>{
            const r = store.put(rec);
            r.onsuccess = ()=>resolve(true);
            r.onerror = ()=>reject(r.error);
          });
        }

        await txDone(tx);
      }
      try{ db.close(); }catch(_){}
    }
  }

  function restoreLocalStorage(obj, mode){
    // mode: 'replace' or 'merge'
    if(mode === 'replace'){
      try{ localStorage.clear(); }catch(_){}
    }
    for(const [k,v] of Object.entries(obj || {})){
      try{ localStorage.setItem(k, v); }catch(_){}
    }
  }

  APP.importBackup = async function(file){
    const text = await file.text();
    const data = JSON.parse(text);

    const isV2 = data && data.meta && data.meta.format === 'WLP_BACKUP_V2';
    const mode = confirm('복원 방식 선택\n\n[확인]=기존 데이터 덮어쓰기(교체)\n[취소]=기존 데이터에 추가(병합)') ? 'replace' : 'merge';
    if(mode === 'replace'){
      if(!confirm('정말로 교체 복원할까요? 현재 데이터가 사라집니다.')) return;
    }

    if(isV2){
      restoreLocalStorage(data.localStorage || {}, mode);
      await restoreIndexedDB(data.indexedDB || {});
      alert('복원 완료');
      location.reload();
      return;
    }

    // Legacy fallback: treat whole JSON as localStorage-like object
    restoreLocalStorage(data || {}, mode);
    alert('복원 완료(레거시)');
    location.reload();
  };

})(window);
