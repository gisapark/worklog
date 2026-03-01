/* WorkLog PRO - App Core (shared utilities + storage safety)
   - 키 통일 / 마이그레이션 / 데이터 무결성 점검
   - 변경로그 표준화
   - 자동 스냅샷 백업(최근 20개)
*/
(function(global){
  'use strict';

  const APP = global.APP || (global.APP = {});

  // ====== Config ======
  APP.SCHEMA_VERSION = 1;

  APP.KEYS = Object.freeze({
    WORKLOG: 'worklog',
    CATEGORIES: 'categories',
    STATUSES: 'statuses',
    MATERIALS: 'materials',

    MATERIAL_LOG: 'materialLog',
    STOCK_BASE: 'materialStockBase',

    SCHEDULE: 'schedule',
    SCHEDULE_LEGACY: 'scheduleData',

    TIMELINE: 'timeline',
    CHANGELOG: 'changeLog',

    AUTO_BACKUPS: 'autoBackups_v1',
    LAST_GOOD: 'lastGoodSnapshot_v1'
    ,
    HIDDEN_DEFAULTS: 'hiddenDefaults_v1'
  });

  
  // Items helper: supports "hide default item" behavior (hiddenDefaults_v1)
  APP.items = (function(){
    const KEY_HIDDEN = APP.KEYS.HIDDEN_DEFAULTS || 'hiddenDefaults_v1';

    function safeParse(str, fallback){
      try{ return JSON.parse(str); }catch(_){ return fallback; }
    }

    function loadHidden(){
      const o = safeParse(localStorage.getItem(KEY_HIDDEN), null);
      const init = {categories:[], statuses:[], materials:[]};
      if(!o || typeof o!=='object' || Array.isArray(o)){
        localStorage.setItem(KEY_HIDDEN, JSON.stringify(init));
        return init;
      }
      o.categories = Array.isArray(o.categories) ? o.categories : [];
      o.statuses = Array.isArray(o.statuses) ? o.statuses : [];
      o.materials = Array.isArray(o.materials) ? o.materials : [];
      return o;
    }

    function isHidden(type, name){
      const v = String(name||'').trim();
      if(!v) return false;
      const h = loadHidden();
      const arr = h[type];
      return Array.isArray(arr) && arr.includes(v);
    }

    function listKeyByType(type){
      if(type==='categories') return APP.KEYS.CATEGORIES;
      if(type==='statuses') return APP.KEYS.STATUSES;
      return APP.KEYS.MATERIALS;
    }

    function getAll(type){
      APP.migrate && APP.migrate.run && APP.migrate.run();
      const key = listKeyByType(type);
      const arr = safeParse(localStorage.getItem(key), []);
      return Array.isArray(arr) ? arr : [];
    }

    function getVisible(type){
      const all = getAll(type);
      const h = loadHidden();
      const hidden = Array.isArray(h[type]) ? h[type] : [];
      if(hidden.length===0) return all;
      return all.filter(x => !hidden.includes(String(x||'').trim()));
    }

    function unhide(type, name){
      const v = String(name||'').trim();
      if(!v) return false;
      const h = loadHidden();
      h[type] = Array.isArray(h[type]) ? h[type] : [];
      const before = h[type].length;
      h[type] = h[type].filter(x => x!==v);
      if(h[type].length !== before){
        localStorage.setItem(KEY_HIDDEN, JSON.stringify(h));
        APP.backup && APP.backup.capture && APP.backup.capture('items.unhide');
        return true;
      }
      return false;
    }

    return Object.freeze({ KEY_HIDDEN, loadHidden, isHidden, getAll, getVisible, unhide });
  })();

APP.util = {
    pad2(n){ return String(n).padStart(2,'0'); },
    ymd(d){
      const dt = d instanceof Date ? d : new Date();
      return dt.getFullYear()+'-'+APP.util.pad2(dt.getMonth()+1)+'-'+APP.util.pad2(dt.getDate());
    },
    todayISO(){ return APP.util.ymd(new Date()); },
    clampInt(v, def=0){
      const n = parseInt(v,10);
      return Number.isFinite(n) ? n : def;
    },
    safeParseJSON(str, fallback){
      try{
        const v = JSON.parse(str);
        return (v === undefined || v === null) ? fallback : v;
      }catch(e){
        return fallback;
      }
    },
    escapeHtml(s){
      return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
    },
    short(s, n){
      const t = String(s||'').replace(/\s+/g,' ').trim();
      if(t.length <= n) return t;
      return t.slice(0,n)+'…';
    },
    stamp(){
      const d=new Date();
      return d.getFullYear()+APP.util.pad2(d.getMonth()+1)+APP.util.pad2(d.getDate())+'_'+APP.util.pad2(d.getHours())+APP.util.pad2(d.getMinutes());
    },
    deepClone(obj){
      return APP.util.safeParseJSON(JSON.stringify(obj), obj);
    }
  };

  // ====== Storage wrapper ======
  APP.store = {
    getRaw(key){ return global.localStorage.getItem(key); },
    setRaw(key, val){ global.localStorage.setItem(key, val); },
    remove(key){ global.localStorage.removeItem(key); },

    getJSON(key, fallback){
      return APP.util.safeParseJSON(global.localStorage.getItem(key), fallback);
    },
    setJSON(key, value){
      global.localStorage.setItem(key, JSON.stringify(value));
    }
  };

  // ====== Standard change log ======
  APP.log = {
    add(type, message, meta){
      const arr = APP.store.getJSON(APP.KEYS.CHANGELOG, []);
      const next = Array.isArray(arr) ? arr : [];
      next.push({ ts: Date.now(), type: String(type||'INFO'), message: String(message||''), meta: meta || null });
      // cap 1000
      if(next.length > 1000) next.splice(0, next.length - 1000);
      APP.store.setJSON(APP.KEYS.CHANGELOG, next);
      APP.backup.capture('changeLog:'+String(type||'INFO'));
    }
  };

  // ====== Auto backup (snapshots) ======
  APP.backup = {
    _debounceTimer: null,

    // major keys only (avoid huge usage)
    _collect(){
      const K = APP.KEYS;
      const keys = [
        K.WORKLOG, K.CATEGORIES, K.STATUSES, K.MATERIALS,
        K.MATERIAL_LOG, K.STOCK_BASE,
        K.SCHEDULE, K.TIMELINE,
        K.CHANGELOG
      ];
      const data = {};
      keys.forEach(k => { data[k] = APP.store.getRaw(k); });
      return { schema: APP.SCHEMA_VERSION, ts: Date.now(), data };
    },

    capture(reason){
      // debounce to avoid spam
      clearTimeout(APP.backup._debounceTimer);
      APP.backup._debounceTimer = setTimeout(()=>{
        try{
          const snap = APP.backup._collect();
          snap.reason = String(reason||'auto');

          // save last-good
          APP.store.setJSON(APP.KEYS.LAST_GOOD, snap);

          // rolling backups
          const arr = APP.store.getJSON(APP.KEYS.AUTO_BACKUPS, []);
          const list = Array.isArray(arr) ? arr : [];
          list.push(snap);
          // keep last 20
          if(list.length > 20) list.splice(0, list.length - 20);
          APP.store.setJSON(APP.KEYS.AUTO_BACKUPS, list);
        }catch(e){
          // ignore (storage quota)
        }
      }, 250);
    },

    exportAll(){
      const obj = {
        meta: { app: 'WorkLogPRO', schema: APP.SCHEMA_VERSION, createdAt: new Date().toISOString() },
        data: {}
      };
      for(let i=0;i<global.localStorage.length;i++){
        const k = global.localStorage.key(i);
        obj.data[k] = global.localStorage.getItem(k);
      }
      return obj;
    },

    importAll(obj, mode){
      // mode: 'replace' | 'merge'
      const payload = obj && obj.data ? obj.data : obj;
      if(!payload || typeof payload !== 'object') throw new Error('형식 오류');

      if(mode === 'replace'){
        global.localStorage.clear();
      }
      Object.keys(payload).forEach(k=>{
        const v = payload[k];
        if(typeof v === 'string') global.localStorage.setItem(k, v);
        else if(v === null) global.localStorage.removeItem(k);
        else global.localStorage.setItem(k, JSON.stringify(v));
      });

      APP.migrate.run();
      APP.backup.capture('import:'+mode);
    }
  };

  // ====== Migration + integrity ======
  APP.migrate = {
    run(){
      const K = APP.KEYS;

      // schedule legacy -> schedule
      const legacy = APP.store.getRaw(K.SCHEDULE_LEGACY);
      const cur = APP.store.getRaw(K.SCHEDULE);
      if(legacy && !cur){
        // try migrate
        APP.store.setRaw(K.SCHEDULE, legacy);
        // keep legacy as fallback (do not delete)
        APP.log.add('MIGRATE', '일정 데이터(scheduleData → schedule) 마이그레이션');
      }

      // normalize arrays for key lists
      function ensureArray(key, defaults){
        const arr = APP.store.getJSON(key, null);
        let list = Array.isArray(arr) ? arr : null;

        // ✨ 변경: 기본값은 "최초 1회 시딩" 용도만 사용 (사용자가 수정/삭제/이름변경 가능)
        // - list가 없거나 비어있을 때만 defaults로 초기화
        // - 이미 list가 있으면 defaults를 강제로 재삽입하지 않음
        if(!Array.isArray(list) || list.length===0){
          list = (defaults||[]).slice();
          APP.store.setJSON(key, list);
          return;
        }

        // 타입만 정리 (중복 제거 + 문자열 trim)
        const seen = new Set();
        const cleaned = [];
        list.forEach(v=>{
          const s = (v==null) ? '' : String(v).trim();
          if(!s) return;
          if(seen.has(s)) return;
          seen.add(s);
          cleaned.push(s);
        });
        APP.store.setJSON(key, cleaned);
      }

      ensureArray(K.CATEGORIES, ['전기','설비','특기사항','비고']);
      ensureArray(K.STATUSES, ['처리완료','진행중','보류','외주','미기록']);
      ensureArray(K.MATERIALS, ['센서등','차동식감지기','연기감지기','정온식감지기','감압밸브','가로등램프','LED10W','아답터','도어클로저']);

      // ensure schedule/timeline arrays
      const sch = APP.store.getJSON(K.SCHEDULE, []);
      if(!Array.isArray(sch)) APP.store.setJSON(K.SCHEDULE, []);

      const tl = APP.store.getJSON(K.TIMELINE, []);
      if(!Array.isArray(tl)) APP.store.setJSON(K.TIMELINE, []);

      const wl = APP.store.getJSON(K.WORKLOG, []);
      if(!Array.isArray(wl)) APP.store.setJSON(K.WORKLOG, []);

      // changelog array
      const cl = APP.store.getJSON(K.CHANGELOG, []);
      if(!Array.isArray(cl)) APP.store.setJSON(K.CHANGELOG, []);

      // material log array
      const ml = APP.store.getJSON(K.MATERIAL_LOG, []);
      if(!Array.isArray(ml)) APP.store.setJSON(K.MATERIAL_LOG, []);

      // stock base object
      const sb = APP.store.getJSON(K.STOCK_BASE, {});
      if(!sb || typeof sb !== 'object' || Array.isArray(sb)) APP.store.setJSON(K.STOCK_BASE, {});

      // keep only stock base keys that exist in materials list
      try{
        const materials = APP.store.getJSON(K.MATERIALS, []);
        const keep = new Set((materials||[]).map(x=>String(x||'').trim()));
        const base = APP.store.getJSON(K.STOCK_BASE, {});
        let changed = false;
        Object.keys(base||{}).forEach(k=>{
          if(!keep.has(String(k||'').trim())){ delete base[k]; changed = true; }
        });
        if(changed) APP.store.setJSON(K.STOCK_BASE, base);
      }catch(e){}

      // mark last-good
      APP.backup.capture('migrate');
    }
  };

  // ====== Safety: recover if JSON broken ======
  APP.safety = {
    restoreLastGood(){
      const snap = APP.store.getJSON(APP.KEYS.LAST_GOOD, null);
      if(!snap || !snap.data) return false;
      const data = snap.data;
      Object.keys(data).forEach(k=>{
        const v = data[k];
        if(v === null) global.localStorage.removeItem(k);
        else global.localStorage.setItem(k, v);
      });
      APP.migrate.run();
      APP.log.add('RECOVER', 'lastGoodSnapshot 복구 실행');
      return true;
    },
    validateJSONKeys(){
      // try parse key JSON and if fails, attempt last-good restore
      const keysToCheck = [
        APP.KEYS.WORKLOG, APP.KEYS.CATEGORIES, APP.KEYS.STATUSES, APP.KEYS.MATERIALS,
        APP.KEYS.MATERIAL_LOG, APP.KEYS.STOCK_BASE,
        APP.KEYS.SCHEDULE, APP.KEYS.TIMELINE,
        APP.KEYS.CHANGELOG
      ];
      for(const k of keysToCheck){
        const raw = global.localStorage.getItem(k);
        if(raw === null) continue;
        try{ JSON.parse(raw); }
        catch(e){
          // broken json
          const ok = APP.safety.restoreLastGood();
          if(!ok){
            // last resort: delete the broken key
            global.localStorage.removeItem(k);
          }
          return false;
        }
      }
      return true;
    }
  };

  // run once early
  try{
    APP.safety.validateJSONKeys();
    APP.migrate.run();
  }catch(e){
    // ignore
  }


  // ====== File-based DB (data.json) for Android-safe persistence ======
  // 어떤 화면에서든 APP.store로 저장이 발생하면 → data.json에 자동 저장
  // 앱 시작 시 저장된 파일 핸들이 있고 권한이 유지되면 → data.json을 읽어 localStorage 복원
  // 주의: 최초 1회 파일 선택/생성은 브라우저 보안상 "사용자 클릭"이 필요합니다.

  APP.fileDB = (function(){
    const CH_NAME = 'wlp_filedb_channel_v1';
    const IDB_NAME = 'wlp_filedb';
    const IDB_STORE = 'kv';
    const HANDLE_KEY = 'dataFileHandle';
    const META_KEY = '__wlp_filedb_meta_v1';
    const SAVE_LOCK_KEY = '__wlp_filedb_lock_v1';

    let handle = null;
    let connected = false;
    let saveTimer = null;
    let bc = null;

    function nowISO(){ return new Date().toISOString(); }

    function idbOpen(){
      return new Promise((resolve, reject)=>{
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = ()=> {
          const db = req.result;
          if(!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = ()=> resolve(req.result);
        req.onerror = ()=> reject(req.error);
      });
    }
    async function idbGet(key){
      const db = await idbOpen();
      return new Promise((resolve, reject)=>{
        const tx = db.transaction(IDB_STORE, 'readonly');
        const st = tx.objectStore(IDB_STORE);
        const r = st.get(key);
        r.onsuccess = ()=> resolve(r.result);
        r.onerror = ()=> reject(r.error);
      });
    }
    async function idbSet(key, val){
      const db = await idbOpen();
      return new Promise((resolve, reject)=>{
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const st = tx.objectStore(IDB_STORE);
        const r = st.put(val, key);
        r.onsuccess = ()=> resolve(true);
        r.onerror = ()=> reject(r.error);
      });
    }

    async function ensurePerm(h, mode){
      if(!h) return false;
      const opts = { mode: mode === 'readwrite' ? 'readwrite' : 'read' };
      try{
        const q = await h.queryPermission(opts);
        if(q === 'granted') return true;
        const r = await h.requestPermission(opts);
        return r === 'granted';
      }catch(_){
        return false;
      }
    }

    function supports(){
      return !!(window.showOpenFilePicker && window.showSaveFilePicker);
    }

    function makeSnapshot(){
      const store = {};
      for(let i=0;i<localStorage.length;i++){
        const k = localStorage.key(i);
        if(!k) continue;
        if(k === SAVE_LOCK_KEY) continue;
        if(k === META_KEY) continue;
        store[k] = localStorage.getItem(k);
      }
      return { meta:{ app:'WorkLogPRO', fileDB:true, schema:1, savedAt: nowISO() }, store };
    }

    function applySnapshot(snap){
      if(!snap || typeof snap !== 'object' || !snap.store || typeof snap.store !== 'object') return false;
      const keep = new Set(Object.keys(snap.store));
      const toRemove = [];
      for(let i=0;i<localStorage.length;i++){
        const k = localStorage.key(i);
        if(!k) continue;
        if(k === SAVE_LOCK_KEY || k === META_KEY) continue;
        if(!keep.has(k)) toRemove.push(k);
      }
      toRemove.forEach(k=> localStorage.removeItem(k));
      Object.keys(snap.store).forEach(k=>{
        try{ localStorage.setItem(k, snap.store[k]); }catch(_){}
      });
      try{
        localStorage.setItem(META_KEY, JSON.stringify({ restoredAt: nowISO(), savedAt: snap?.meta?.savedAt || null }));
      }catch(_){}
      return true;
    }

    async function readFile(h){
      const f = await h.getFile();
      return await f.text();
    }
    async function writeFile(h, obj){
      const ok = await ensurePerm(h, 'readwrite');
      if(!ok) return { ok:false, reason:'no-permission' };
      try{
        const w = await h.createWritable();
        await w.write(JSON.stringify(obj, null, 2));
        await w.close();
        return { ok:true };
      }catch(e){
        return { ok:false, reason: (e && e.message) ? e.message : String(e) };
      }
    }

    function acquireSaveLock(){
      const token = String(Date.now()) + '_' + Math.random().toString(16).slice(2);
      const now = Date.now();
      try{
        const cur = localStorage.getItem(SAVE_LOCK_KEY);
        if(cur){
          const parsed = (window.APP && APP.util && APP.util.safeParseJSON) ? APP.util.safeParseJSON(cur, null) : null;
          if(parsed && parsed.expiresAt && parsed.expiresAt > now) return { ok:false, token:null };
        }
        localStorage.setItem(SAVE_LOCK_KEY, JSON.stringify({ token, expiresAt: now + 4000 }));
        return { ok:true, token };
      }catch(_){
        return { ok:true, token };
      }
    }
    function releaseSaveLock(token){
      try{
        const cur = (window.APP && APP.util && APP.util.safeParseJSON) ? APP.util.safeParseJSON(localStorage.getItem(SAVE_LOCK_KEY), null) : null;
        if(cur && cur.token === token) localStorage.removeItem(SAVE_LOCK_KEY);
      }catch(_){}
    }

    async function saveNow(){
      if(!handle) return { ok:false, reason:'no-handle' };
      const lock = acquireSaveLock();
      if(!lock.ok) return { ok:false, reason:'busy' };
      const snap = makeSnapshot();
      const res = await writeFile(handle, snap);
      releaseSaveLock(lock.token);
      if(res.ok) broadcast({ type:'saved', at: nowISO() });
      return res;
    }
    function scheduleSave(){
      if(saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(()=>{ saveNow(); }, 250);
    }

    function broadcast(msg){
      try{
        if(!bc) bc = new BroadcastChannel(CH_NAME);
        bc.postMessage(msg);
      }catch(_){}
    }
    function listen(){
      try{
        if(!bc) bc = new BroadcastChannel(CH_NAME);
        bc.onmessage = (ev)=>{
          const d = ev.data || {};
          if(d.type === 'restored'){
            try{
              const key='__wlp_reloaded_after_restore';
              if(!sessionStorage.getItem(key)){
                sessionStorage.setItem(key,'1');
                if(window===window.top){
                  window.dispatchEvent(new Event('wlp-filedb-restored'));
                }else{
                  location.reload();
                }
              }
            }catch(_){}
          }
        };
      }catch(_){}
    }

    async function loadAndRestore(h){
      const ok = await ensurePerm(h, 'read');
      if(!ok) return { ok:false, reason:'no-permission' };
      let snap = null;
      try{
        const txt = await readFile(h);
        if(txt && txt.trim()){
          snap = (window.APP && APP.util && APP.util.safeParseJSON) ? APP.util.safeParseJSON(txt, null) : null;
          if(!snap){
            try{ snap = JSON.parse(txt); }catch(_){ snap = null; }
          }
        }
      }catch(_){}
      if(!snap){
        snap = makeSnapshot();
        await writeFile(h, snap);
      }
      const applied = applySnapshot(snap);
      if(applied){
        connected = true;
        handle = h;
        broadcast({ type:'restored', at: nowISO() });
        return { ok:true };
      }
      return { ok:false, reason:'apply-failed' };
    }

    async function connectExisting(){
      if(!supports()){
        alert('이 브라우저는 파일 선택/생성 API를 지원하지 않습니다. Chrome/Edge 권장');
        return { ok:false, reason:'no-api' };
      }
      try{
        const [h] = await window.showOpenFilePicker({
          multiple:false,
          types:[{ description:'JSON', accept:{ 'application/json':['.json'] } }]
        });
        if(!h) return { ok:false, reason:'no-handle' };
        await idbSet(HANDLE_KEY, h);
        return await loadAndRestore(h);
      }catch(e){
        return { ok:false, reason: (e && e.name) ? e.name : String(e) };
      }
    }

    async function createNew(){
      if(!supports()){
        alert('이 브라우저는 파일 선택/생성 API를 지원하지 않습니다. Chrome/Edge 권장');
        return { ok:false, reason:'no-api' };
      }
      try{
        const h = await window.showSaveFilePicker({
          suggestedName:'data.json',
          types:[{ description:'JSON', accept:{ 'application/json':['.json'] } }]
        });
        if(!h) return { ok:false, reason:'no-handle' };
        await idbSet(HANDLE_KEY, h);
        const ok = await ensurePerm(h, 'readwrite');
        if(!ok) return { ok:false, reason:'no-permission' };
        const snap = makeSnapshot();
        const wr = await writeFile(h, snap);
        if(!wr.ok) return wr;
        return await loadAndRestore(h);
      }catch(e){
        return { ok:false, reason: (e && e.name) ? e.name : String(e) };
      }
    }

    async function tryAutoConnect(){
      try{
        const h = await idbGet(HANDLE_KEY);
        if(!h) return { ok:false, reason:'no-stored' };
        const ok = await ensurePerm(h, 'read');
        if(!ok) return { ok:false, reason:'no-permission' };
        return await loadAndRestore(h);
      }catch(e){
        return { ok:false, reason:String(e) };
      }
    }

    function isConnected(){ return connected && !!handle; }
    function getFileName(){ try{ return handle ? (handle.name || 'data.json') : ''; }catch(_){ return ''; } }

    function hookStore(){
      if(window.APP && APP.store && !APP.store.__fileDBHooked){
        const _setRaw = APP.store.setRaw.bind(APP.store);
        const _setJSON = APP.store.setJSON.bind(APP.store);
        const _remove = APP.store.remove.bind(APP.store);
        APP.store.setRaw = function(key, val){ _setRaw(key,val); if(isConnected()) scheduleSave(); };
        APP.store.setJSON = function(key, value){ _setJSON(key,value); if(isConnected()) scheduleSave(); };
        APP.store.remove = function(key){ _remove(key); if(isConnected()) scheduleSave(); };
        APP.store.__fileDBHooked = true;
      }
    }

    async function uiConnect(){
      const res = await connectExisting();
      if(res.ok){
        alert('data.json 연결 완료: ' + getFileName());
        window.dispatchEvent(new Event('wlp-filedb-restored'));
      }else if(res.reason !== 'AbortError'){
        alert('연결 실패: ' + res.reason);
      }
      return res;
    }
    async function uiNew(){
      const res = await createNew();
      if(res.ok){
        alert('data.json 생성/연결 완료: ' + getFileName());
        window.dispatchEvent(new Event('wlp-filedb-restored'));
      }else if(res.reason !== 'AbortError'){
        alert('생성 실패: ' + res.reason);
      }
      return res;
    }

    (function init(){
      listen();
      hookStore();
      tryAutoConnect().then(r=>{ if(r.ok){ try{ window.dispatchEvent(new Event('wlp-filedb-restored')); }catch(_){}}});
    })();

    return { uiConnect, uiNew, isConnected, getFileName, scheduleSave, saveNow, tryAutoConnect };
  })();

  // Expose for onclick (index.html)
  global.connectDataFile = function(){ return APP.fileDB.uiConnect(); };
  global.newDataFile = function(){ return APP.fileDB.uiNew(); };

})(window);
