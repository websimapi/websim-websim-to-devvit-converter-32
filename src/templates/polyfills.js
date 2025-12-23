export const simpleLoggerJs = `
// [WebSim] Logger Polyfill - Global Script
(function() {
  const _log = console.log;
  const _warn = console.warn;
  const _error = console.error;
  const _info = console.info;

  function post(level, args) {
    try {
      const msgPreview = args.map(String).join(' ');
      if (msgPreview.includes('AudioContext') || msgPreview.includes('acknowledgeRemotionLicense')) return;

      const serialized = args.map(a => {
        if (a === undefined) return 'undefined';
        if (a === null) return 'null';
        if (a instanceof Error) return '[Error: ' + (a.message || 'unknown') + ']';
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch(e) { return '[Circular]'; }
        }
        return String(a);
      });
      
      if (window.parent) {
          window.parent.postMessage(JSON.stringify({ type: 'console', level, args: serialized }), '*');
      }
    } catch(e) {}
  }

  console.log = function(...args) { _log.apply(console, args); post('info', args); };
  console.info = function(...args) { _info.apply(console, args); post('info', args); };
  console.warn = function(...args) { _warn.apply(console, args); post('warn', args); };
  console.error = function(...args) { _error.apply(console, args); post('error', args); };

  window.addEventListener('error', function(e) {
    post('error', ['[Uncaught]', e.message]);
  });
})();
`;

export const webAudioPolyfill = `
// [WebSim] Audio Polyfill - Reddit/Devvit Compliance & Crash Prevention
(function() {
    console.log("[Audio] Initializing Reddit-compliant Audio Manager...");

    // 1. Context Tracking for Visibility/Unlock
    const contexts = new Set();
    let unlocked = false;

    // Helper: Create a generic silent buffer (1s) to return on error
    function createSilentBuffer(ctx) {
        // Create a tiny buffer (1 sample) just to satisfy the interface
        return ctx.createBuffer(1, 1, 22050);
    }

    // 2. Wrap AudioContext to intercept decodeAudioData and handle suspension
    const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    
    if (NativeAudioContext) {
        class PolyfillAudioContext extends NativeAudioContext {
            constructor(opts) {
                super(opts);
                contexts.add(this);
                
                // Ensure we start suspended until interaction (browsers mostly do this, but being explicit helps)
                if (this.state === 'running' && !unlocked) {
                    this.suspend().catch(() => {});
                }
            }

            // Safe Decode: Catches malformed buffers (e.g. HTML 404s) preventing app crash
            decodeAudioData(buffer, successCallback, errorCallback) {
                const isPromise = !successCallback && !errorCallback;

                // 1. Validation: If buffer is bad/empty, fail gracefully immediately
                if (!buffer || buffer.byteLength === 0) {
                    console.warn("[Audio] Empty/Null buffer passed to decodeAudioData. Serving silence.");
                    const silent = createSilentBuffer(this);
                    if (successCallback) successCallback(silent);
                    return isPromise ? Promise.resolve(silent) : undefined;
                }

                // 2. Execute Decode
                // We wrap the Promise result to catch errors even if callbacks are used (modern browsers return Promise + callbacks)
                const promise = super.decodeAudioData(buffer, 
                    (decoded) => {
                        if (successCallback) successCallback(decoded);
                    },
                    (err) => {
                        console.warn("[Audio] Decode Error (callback):", err.message);
                        // Serve silence instead of erroring
                        const silent = createSilentBuffer(this);
                        if (successCallback) successCallback(silent);
                        // We suppress the errorCallback to keep game running
                    }
                );

                // 3. Handle Promise Rejection (Common in modern usage)
                if (promise && promise.catch) {
                    return promise.catch(err => {
                        console.warn("[Audio] Decode Error (promise):", err.message);
                        // Return silence
                        const silent = createSilentBuffer(this);
                        // If user provided a success callback, we already called it above in the error handler wrapper if supported,
                        // but if they rely purely on promise:
                        return silent;
                    });
                }
                
                return promise;
            }
        }

        window.AudioContext = PolyfillAudioContext;
        window.webkitAudioContext = PolyfillAudioContext;
    }

    // 3. User Interaction Unlock (Reddit Rule: No Autoplay)
    const unlockEvents = ['click', 'touchstart', 'keydown', 'mousedown'];
    const unlockFn = () => {
        if (unlocked) return;
        unlocked = true;
        console.log("[Audio] Unlocking Audio Contexts...");
        contexts.forEach(ctx => {
            if (ctx.state === 'suspended') ctx.resume().catch(e => console.warn(e));
        });
        unlockEvents.forEach(e => window.removeEventListener(e, unlockFn));
    };
    unlockEvents.forEach(e => window.addEventListener(e, unlockFn));

    // 4. Visibility Handling (Reddit Rule: Mute when hidden)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            console.log("[Audio] App hidden, suspending...");
            contexts.forEach(ctx => ctx.suspend().catch(() => {}));
        } else {
            console.log("[Audio] App visible, resuming...");
            if (unlocked) {
                contexts.forEach(ctx => {
                    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
                });
            }
        }
    });

})();
`;

export const websimSocketPolyfill = `
// [WebSim] Generic DB & Bridge Polyfill
(function() {
    // ------------------------------------------------------------------------
    // 1. Generic Bridge (Devvit <-> Webview)
    // ------------------------------------------------------------------------
    window._genericDB = {};
    window._listCache = {}; // Cache for stable array references
    window._subscribers = {};
    window._currentUser = null;

    const DevvitBridge = {
        init: async () => {
            console.log("[Bridge] Initializing...");
            
            try {
                // Load initial data from server via HTTP
                const data = await fetch('/api/init').then(r => r.json());
                
                if (data.dbData) {
                    window._genericDB = data.dbData;
                    window._listCache = {}; // Reset cache
                    
                    // Hot-swap identity: Use Reddit identity from server
                    window._currentUser = data.user;
                    console.log("[Bridge] Identity Swapped:", window._currentUser);
                    
                    // Legacy stub support
                    if (window.WebsimSocket && window.WebsimSocket.updateIdentity && data.user) {
                        window.WebsimSocket.updateIdentity(data.user);
                    }
                    
                    const readyEvent = new CustomEvent('GAMEDATA_READY', { 
                        detail: data.dbData 
                    });
                    window.dispatchEvent(readyEvent);
                    
                    Object.keys(window._subscribers).forEach(col => {
                        DevvitBridge.notifySubscribers(col);
                    });
                }
            } catch (e) {
                console.warn("[Bridge] Init failed (might be offline)", e);
            }
        },

        getListSnapshot: (collection) => {
            if (!window._listCache[collection]) {
                const list = Object.values(window._genericDB[collection] || {});
                list.sort((a,b) => (b.created_at || 0) < (a.created_at || 0) ? -1 : 1);
                window._listCache[collection] = list;
            }
            return window._listCache[collection];
        },

        notifySubscribers: (collection) => {
            // Invalidate cache
            delete window._listCache[collection];
            const list = DevvitBridge.getListSnapshot(collection);
            
            if (window._subscribers[collection]) {
                window._subscribers[collection].forEach(cb => {
                    try { cb(list); } catch(e) { console.error(e); }
                });
            }
        }
    };

    // Expose API
    window.GenericDB = {
        save: async (collection, key, value) => {
            if (!window._genericDB[collection]) {
                window._genericDB[collection] = {};
            }
            window._genericDB[collection][key] = value;
            
            // Optimistic local update
            DevvitBridge.notifySubscribers(collection);
            
            // Send to server via HTTP
            try {
                await fetch('/api/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ collection, key, value })
                });
            } catch (e) {
                console.error("[Bridge] Save failed:", e);
            }
        },
        
        get: (collection, key) => {
            return window._genericDB[collection]?.[key] || null;
        },
        
        getAll: (collection) => {
            return window._genericDB[collection] || {};
        },

        getList: (collection) => {
            return DevvitBridge.getListSnapshot(collection);
        },
        
        // Async get from server (bypasses cache)
        fetchFromServer: async (collection, key) => {
            try {
                const res = await fetch('/api/load', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ collection, key })
                });
                const data = await res.json();
                return data.value;
            } catch(e) { 
                console.error("[Bridge] Load failed:", e);
                return null; 
            }
        },
        
        delete: async (collection, key) => {
            if (window._genericDB[collection]) {
                delete window._genericDB[collection][key];
            }
            DevvitBridge.notifySubscribers(collection);
            
            try {
                await fetch('/api/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ collection, key })
                });
            } catch (e) {
                console.error("[Bridge] Delete failed:", e);
            }
        },
        
        subscribe: (collection, callback) => {
            if (!window._subscribers[collection]) {
                window._subscribers[collection] = [];
            }
            window._subscribers[collection].push(callback);
            
            // Immediate callback with current data
            // Use cached snapshot to prevent React infinite loops
            const currentList = DevvitBridge.getListSnapshot(collection);
            try { callback(currentList); } catch(e) {}
            
            // Return unsubscribe function
            return () => {
                window._subscribers[collection] = 
                    window._subscribers[collection].filter(f => f !== callback);
            };
        }
    };

    // Initialize on load
    if (document.readyState === 'complete') {
        setTimeout(DevvitBridge.init, 100);
    } else {
        window.addEventListener('load', () => setTimeout(DevvitBridge.init, 100));
    }

    // ------------------------------------------------------------------------
    // 2. WebSim Adapter (Backward Compatibility)
    // ------------------------------------------------------------------------
    class AdapterCollection {
        constructor(name) { this.name = name; }
        
        getList = () => { 
            return window.GenericDB.getList(this.name);
        }
        
        create = async (data) => {
            const id = Math.random().toString(36).substr(2, 12);
            
            // Enforce Reddit Identity on content creation
            const enhancedData = { ...data };
            if (window._currentUser) {
                enhancedData.username = window._currentUser.username;
                enhancedData.avatar_url = window._currentUser.avatar_url;
                enhancedData.user_id = window._currentUser.id;
            }

            const record = { 
                id, 
                ...enhancedData, 
                created_at: new Date().toISOString() 
            };
            window.GenericDB.save(this.name, id, record);
            return record;
        }

        update = async (id, data) => {
            const current = window.GenericDB.get(this.name, id);
            // If not found in cache, we could optionally await fetchFromServer here, 
            // but strict WebSim API is synchronous for getList/etc usually, async for update.
            // For now, assume hydration is complete or we rely on cache.
            if (!current) throw new Error('Record not found or not loaded');
            
            const record = { ...current, ...data };
            window.GenericDB.save(this.name, id, record);
            return record;
        }

        delete = async (id) => {
             await window.GenericDB.delete(this.name, id);
        }

        subscribe = (cb) => {
            return window.GenericDB.subscribe(this.name, cb);
        }
        
        filter(criteria) {
             const self = this;
             return {
                 getList: () => self.getList().filter(r => self._matches(r, criteria)),
                 subscribe: (cb) => {
                     const wrapped = (list) => cb(list.filter(r => self._matches(r, criteria)));
                     return self.subscribe(wrapped);
                 }
             };
        }
        _matches(record, criteria) {
            for (let key in criteria) { if (record[key] !== criteria[key]) return false; }
            return true;
        }
    }

    // Mock WebSimSocket Class
    window.WebsimSocket = class WebsimSocket {
        constructor() {
            if (!window.websimSocketInstance) {
                window.websimSocketInstance = { 
                    collection: (name) => new AdapterCollection(name) 
                };
            }
            return window.websimSocketInstance;
        }
        static updateIdentity(user) {
            window._currentUser = user;
        }
    };
    
    // Auto-instantiate if game expects 'party'
    if (!window.party) { 
        window.websimSocketInstance = { 
            collection: (name) => new AdapterCollection(name) 
        };
        window.party = window.websimSocketInstance; 
    }
})();
`;

export const websimStubsJs = `
// [WebSim] API Stubs - Global Script
(function() {
    let _currentUser = null;

    // Listen for identity update from Socket Handshake or direct message
    const updateIdentity = (user) => {
        _currentUser = user;
        if (window.WebsimSocket && window.WebsimSocket.updateIdentity) {
            window.WebsimSocket.updateIdentity(user);
        }
    };

    // Also listen to window messages for 'set_user_context' just in case
    window.addEventListener('message', (e) => {
        let data = e.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch(e) {} }
        if (data && (data.type === 'set_user_context' || (data.payload && data.payload.user))) {
            const user = data.payload.user || data.payload;
            updateIdentity(user);
        }
    });

    if (!window.websim) {
        window.websim = {
            getCurrentUser: async () => {
                // Wait for handshake
                let tries = 0;
                while(!_currentUser && tries < 20) {
                    await new Promise(r => setTimeout(r, 100));
                    tries++;
                }
                return _currentUser || {
                    id: 'guest', username: 'Guest', avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                };
            },
            getProject: async () => ({ id: 'local', title: 'Reddit Game' }),
            collection: (name) => {
                // Return safe stubs to prevent crashes before hydration
                return window.websimSocketInstance ? window.websimSocketInstance.collection(name) : {
                    subscribe: () => {}, 
                    getList: () => [], 
                    create: async () => {}, 
                    update: async () => {}, 
                    delete: async () => {}, 
                    filter: () => ({ subscribe: () => {}, getList: () => [] })
                };
            },
            upload: async (blob) => {
                // 1. JSON Persistence (Save Files / Levels)
                // We hijack JSON uploads to store them in Redis, allowing persistent "save files"
                if (blob.type.includes('json') || blob.type.includes('text')) {
                    try {
                        const text = await blob.text();
                        // Verify valid JSON
                        JSON.parse(text);
                        
                        const key = Math.random().toString(36).substring(2, 15);
                        const res = await fetch('/api/json/' + key, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: text
                        });
                        
                        if (res.ok) {
                            return '/api/json/' + key;
                        }
                    } catch(e) {
                        console.warn('[WebSim] JSON Upload fallback:', e);
                    }
                }
                
                // 2. Fallback for Images/Media
                // Note: These are temporary and won't persist after reload unless using Devvit Forms
                try { return URL.createObjectURL(blob); } catch(e) { return ''; }
            }
        };
    }
})();
`;

export const jsxDevProxy = `
// Shim for react/jsx-dev-runtime to work in production Vite builds
import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';

export const Fragment = _Fragment;
export const jsx = _jsx;
export const jsxs = _jsxs;

// Proxy jsxDEV to jsx (ignores the extra dev-only arguments)
export const jsxDEV = (type, props, key, isStaticChildren, source, self) => {
  return _jsx(type, props, key);
};
`;

export const websimPackageJs = `
// Bridge for "import websim from 'websim'"
const w = window.websim || {};
export default w;
// Export common methods if destructured
export const getProject = w.getProject;
export const getCurrentUser = w.getCurrentUser;
export const upload = w.upload;
export const collection = w.collection;
`;



