/*
 * Trace MV3 bridge for extension pages (options, popup, dashboard, blocked page).
 *
 * In Manifest V2 these pages reached straight into the background page with
 * chrome.extension.getBackgroundPage() and read/changed its objects directly.
 * Manifest V3 has a service worker instead, which pages can't touch.
 *
 * This file recreates that "background page" object:
 *  - Data (Prefs.Current, Whitelist lists, Vars, Tabs.TabList...) comes from a
 *    snapshot the service worker sends, so pages can keep reading it synchronously.
 *  - Function calls (bg.Prefs.Set, bg.Whitelist.AddItem(..., cb)...) are forwarded
 *    to the service worker; callbacks run when it answers, after the snapshot
 *    has been refreshed.
 *  - Assignments like bg.Vars.paused = true are forwarded too.
 * The page's own scripts (listed in data-load) are only loaded once the first
 * snapshot has arrived, so they never see an empty background.
 */
(function(){
	"use strict";

	var me = document.currentScript;
	var toLoad = (me.getAttribute("data-load") || "").split(/\s+/).filter(Boolean);
	var snap = {};

	// ---------- helpers ----------
	var wildcardToRegExp = function(s){
		var esc = function(x){ return x.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&'); };
		return new RegExp('^' + s.split(/\*+/).map(esc).join('.*') + '$');
	};

	var getPath = function(obj, path){
		var parts = path.split("."), cur = obj;
		for (var i = 0; i < parts.length; i++){
			if (cur === null || cur === undefined) return undefined;
			cur = cur[parts[i]];
		}
		return cur;
	};

	var setPath = function(obj, path, val){
		var parts = path.split("."), cur = obj;
		for (var i = 0; i < parts.length - 1; i++){
			if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
			cur = cur[parts[i]];
		}
		cur[parts[parts.length - 1]] = val;
	};

	var applySnapshot = function(s){
		if (!s) return;
		// Rebuild the RegExp-based whitelist structures pages expect
		if (s.Whitelist){
			s.Whitelist.decodedList = {
				keys:(s.Whitelist.decodedKeySources || []).map(function(src){ return new RegExp(src); }),
				values:s.Whitelist.decodedValues || []
			};
			s.Whitelist.tempList = {
				search:s.Whitelist.tempSearch || [],
				keys:(s.Whitelist.tempSearch || []).map(wildcardToRegExp),
				values:s.Whitelist.tempValues || []
			};
		}
		snap = s;
	};

	var send = function(message){
		return new Promise(function(resolve){
			try {
				chrome.runtime.sendMessage(message, function(resp){
					if (chrome.runtime.lastError){
						console.warn("[Trace bridge]", chrome.runtime.lastError.message);
						resolve({});
						return;
					}
					resolve(resp || {});
				});
			} catch(e){
				console.warn("[Trace bridge]", e);
				resolve({});
			}
		});
	};

	var clean = function(v){
		try {
			return JSON.parse(JSON.stringify(v));
		} catch(e){
			return null;
		}
	};

	// Forward a call to the service worker; function arguments become callbacks
	var call = function(path, args){
		args = Array.prototype.slice.call(args || []);
		var cbIndexes = [], sendArgs = [];
		args.forEach(function(a, i){
			if (typeof a === "function"){
				cbIndexes.push(i);
				sendArgs.push(null);
			} else {
				sendArgs.push(clean(a));
			}
		});

		send({msg:"mv3-bg", op:"call", path:path, args:sendArgs, cbIndexes:cbIndexes}).then(function(r){
			if (r.error) console.warn("[Trace bridge] " + path + ": " + r.error);
			applySnapshot(r.snap);
			if (typeof r.cbIndex === "number" && typeof args[r.cbIndex] === "function"){
				args[r.cbIndex].apply(null, r.cbArgs || []);
			}
		});
	};

	// Things pages call that must answer synchronously, or only make sense locally
	var local = {
		"Prefs.GetSetting":function(setting){
			return getPath(snap.Prefs.Current, setting);
		},
		"Prefs.Set":function(setting, val, disablePresets){
			setPath(snap.Prefs.Current, setting, clean(val));
			call("Prefs.Set", [setting, val, disablePresets === undefined ? true : disablePresets]);
		},
		"Prefs.SetMultiple":function(settings, disablePresets){
			Object.keys(settings).forEach(function(k){
				setPath(snap.Prefs.Current, k, clean(settings[k]));
			});
			call("Prefs.SetMultiple", [settings, disablePresets === undefined ? true : disablePresets]);
		},
		"Whitelist.GetWhitelist":function(){
			var d = snap.Whitelist.decodedList, t = snap.Whitelist.tempList;
			return {
				keys:[].concat(d.keys, t.keys),
				values:[].concat(d.values, t.values)
			};
		}
	};

	// Proxy for an unknown path: reading goes deeper, calling forwards the call
	var pathProxy = function(path){
		return new Proxy(function(){}, {
			get:function(t, key){
				if (key === "then" || typeof key === "symbol") return undefined;
				return pathProxy(path + "." + key);
			},
			apply:function(t, thisArg, args){
				return call(path, args);
			}
		});
	};

	var moduleProxy = function(name){
		return new Proxy({}, {
			get:function(t, key){
				if (typeof key === "symbol") return undefined;
				var full = name + "." + key;
				if (local[full]) return local[full];

				var mod = snap[name];
				if (mod && Object.prototype.hasOwnProperty.call(mod, key) && mod[key] !== undefined){
					var val = mod[key];
					// Data objects that also contain functions (e.g. Trace.f) aren't in
					// the snapshot, so anything found here is plain data
					return val;
				}
				return pathProxy(full);
			},
			set:function(t, key, val){
				if (!snap[name]) snap[name] = {};
				snap[name][key] = val;
				send({msg:"mv3-bg", op:"set", path:name + "." + key, value:clean(val)}).then(function(r){
					applySnapshot(r.snap);
				});
				return true;
			}
		});
	};

	var BG = new Proxy({}, {
		get:function(t, key){
			if (typeof key === "symbol") return undefined;
			switch (key){
				case "window":
					return {location:{reload:function(){ call("MV3.Restart", []); }}};
				case "MD5":
					return window.MD5;
				case "_UserCrashReportService":
					return function(){ return false; };
				case "chrome":
					return chrome;
				default:
					return moduleProxy(key);
			}
		}
	});

	// Replace both ways pages ask for the background page
	var getBg = function(){ return BG; };
	var getBgAsync = function(cb){
		if (typeof cb === "function"){
			cb(BG);
			return;
		}
		return Promise.resolve(BG);
	};
	try {
		chrome.extension = chrome.extension || {};
		Object.defineProperty(chrome.extension, "getBackgroundPage", {value:getBg, configurable:true, writable:true});
	} catch(e){ console.warn(e); }
	try {
		Object.defineProperty(chrome.runtime, "getBackgroundPage", {value:getBgAsync, configurable:true, writable:true});
	} catch(e){ console.warn(e); }

	// Load the page's real scripts in order once the first snapshot is here
	var loadNext = function(){
		if (toLoad.length === 0) return;
		var s = document.createElement("script");
		s.src = toLoad.shift();
		s.onload = loadNext;
		s.onerror = function(){
			console.error("[Trace bridge] Failed to load " + s.src);
			loadNext();
		};
		(document.body || document.head || document.documentElement).appendChild(s);
	};

	var start = function(attempt){
		send({msg:"mv3-bg", op:"snapshot"}).then(function(r){
			if (!r.snap && attempt < 20){
				// Service worker still starting up
				setTimeout(function(){ start(attempt + 1); }, 150);
				return;
			}
			applySnapshot(r.snap);
			loadNext();
		});
	};
	start(0);
})();
