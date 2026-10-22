/*
 * Trace MV3: adapt the original background modules to a service worker.
 *
 * - Request blocking / header changes go through Rules (declarativeNetRequest).
 * - State that only lived in memory (spoofed identity, pause, temporary
 *   whitelist, per-tab counters) is kept in chrome.storage.session, because a
 *   service worker is stopped after ~30s idle and would otherwise pick a new
 *   identity every time it wakes up.
 * - Extension pages talk to this worker through js/mv3/bridge.js.
 */

// ---------- module registry (some modules are `let`, so not on self) ----------
MV3.Modules = {
	Alarms:Alarms, Headers:Headers, Prefs:Prefs, Session:Session, Simple:Simple,
	Stats:Stats, Tabs:Tabs, Trace:Trace, Vars:Vars, Web:Web, WebBlocker:WebBlocker,
	Whitelist:Whitelist, Rules:Rules, MV3:MV3
};

// ---------- request handling: everything becomes "rebuild the rules" ----------
["Cookie","Etag","Google","IPSpoof","Referer","UserAgent"].forEach(function(name){
	Headers[name].Start = function(){ Rules.Schedule(); };
	Headers[name].Stop = function(){ Rules.Schedule(); };
});
Headers.Execute = function(){ Rules.Schedule(); };

WebBlocker.AssignChecker = function(){ WebBlocker.meta.isBlocking = true; Rules.Schedule(); };
WebBlocker.RemoveChecker = function(){ WebBlocker.meta.isBlocking = false; Rules.Schedule(); };
WebBlocker.RestartChecker = function(){ Rules.Schedule(); };
Web.ToggleBlockPings = function(){ Rules.Schedule(); };

// Blocklist: XMLHttpRequest doesn't exist in a service worker
Web.GetBlockList = function(attempt, server){
	let url = Web.BlocklistURL(attempt, server);
	fetch(url).then(function(r){
		if (!r.ok) throw new Error("HTTP " + r.status);
		return r.json();
	}).then(function(data){
		Web.ApplyWebBlocklist(data, server);
	}).catch(function(e){
		Trace.Notify("Couldn't load the blocklist (" + e.message + ")", "protd");
	});
};
(function(){
	let orig = Web.ApplyWebBlocklist;
	Web.ApplyWebBlocklist = function(db, fromServer){
		orig(db, fromServer);
		Rules.Schedule();
	};
})();

// ---------- alarms: don't reset a running timer every time the worker wakes ----------
(function(){
	let create = chrome.alarms.create.bind(chrome.alarms);
	MV3.CreateAlarm = function(name, info){
		if (!info || typeof info.periodInMinutes !== "number"){
			return create(name, info);
		}
		chrome.alarms.get(name, function(existing){
			if (existing && existing.periodInMinutes === info.periodInMinutes) return;
			create(name, info);
		});
	};
	try {
		chrome.alarms.create = MV3.CreateAlarm;
	} catch(e){
		console.warn("[mv3]-> Couldn't wrap chrome.alarms.create", e);
	}
})();

// ---------- spoofed identity survives worker restarts ----------
MV3.IdentityKeys = ["useragent","oscpu","platform","vendor","uaFamily","uaBrand","uaMajor","uaPlatformName",
	"gpuChose","gpuVendor","glVendor","glRenderer"];

MV3.SaveIdentity = function(){
	if (MV3.restoring) return;
	let id = {fakeIP:Trace.i.CurrentFakeIP, via:Trace.i.CurrentViaHeader};
	MV3.IdentityKeys.forEach(function(k){ id[k] = Vars[k]; });
	chrome.storage.session.set({mv3_identity:id});
};

MV3.RestoreIdentity = function(id){
	if (!id || typeof id.useragent !== "string") return false;
	MV3.IdentityKeys.forEach(function(k){
		if (id[k] !== undefined) Vars[k] = id[k];
	});
	if (typeof id.fakeIP === "string") Trace.i.CurrentFakeIP = id.fakeIP;
	if (typeof id.via === "string") Trace.i.CurrentViaHeader = id.via;
	return true;
};

// While starting up with a saved identity, keep it instead of picking a new one
["ChooseUserAgent","ChooseGPU"].forEach(function(fn){
	let orig = Alarms.Updaters[fn];
	Alarms.Updaters[fn] = function(){
		if (MV3.restoring && MV3.identityRestored) return;
		let r = orig.apply(this, arguments);
		MV3.SaveIdentity();
		Rules.Schedule();
		return r;
	};
});
(function(){
	let orig = Trace.i.RefreshFakeUserIP;
	Trace.i.RefreshFakeUserIP = function(){
		if (MV3.restoring && MV3.identityRestored) return;
		orig.apply(this, arguments);
		MV3.SaveIdentity();
		Rules.Schedule();
	};
	let origToggle = Trace.i.ToggleIPSpoof;
	Trace.i.ToggleIPSpoof = function(){
		origToggle.apply(this, arguments);
		MV3.SaveIdentity();
		Rules.Schedule();
	};
})();

// ---------- pause state ----------
MV3.SavePause = function(){
	chrome.storage.session.set({mv3_pause:{paused:Vars.paused, pauseEnd:Vars.pauseEnd}});
	Rules.Schedule();
};

// ---------- temporary whitelist ----------
(function(){
	let save = function(){
		chrome.storage.session.set({mv3_tempwl:Whitelist.tempList.search.slice()});
		Rules.Schedule();
	};
	let add = Whitelist.AddTempItem, remove = Whitelist.RemoveTempItem;
	Whitelist.AddTempItem = function(item, cb){
		let r = add(item, cb);
		if (!MV3.restoring) save();
		return r;
	};
	Whitelist.RemoveTempItem = function(item, cb){
		let r = remove(item, cb);
		save();
		return r;
	};

	// The original reloaded the whole background page here
	Whitelist.UpdateStorage = function(cb){
		Prefs.s.set({"Main_PageList":Whitelist.storedList}, function(){
			Rules.Schedule();
			if (cb) cb();
		});
	};

	let origLoad = Whitelist.LoadWhitelist;
	Whitelist.LoadWhitelist = function(cb){
		let r = origLoad.call(this, cb);
		Rules.Schedule();
		return r;
	};
})();

// ---------- per-tab counters (popup) ----------
Tabs.AssignEvents = function(){};		// listeners are registered at top level in sw.js
Tabs.RemoveEvents = function(){};
(function(){
	let timer = null;
	MV3.SaveTabs = function(){
		clearTimeout(timer);
		timer = setTimeout(function(){
			chrome.storage.session.set({mv3_tabs:Tabs.TabList});
		}, 1000);
	};
	["LogRequest","LogHeaders"].forEach(function(fn){
		if (typeof Tabs[fn] !== "function") return;
		let orig = Tabs[fn];
		Tabs[fn] = function(){
			let r = orig.apply(this, arguments);
			MV3.SaveTabs();
			return r;
		};
	});
})();

// ---------- cookies: remove listed tracking cookies (replaces Set-Cookie filtering) ----------
MV3.CookieChanged = function(info){
	if (info.removed || Vars.paused === true) return;
	let c = Prefs.Current.Pref_CookieEater;
	if (!c || c.enabled !== true) return;

	let ck = c.settings.cookie, sc = c.settings.setcookie;
	let wantsList = function(s){
		return s.enabled === true && (s.fp_method === "remove" || s.tp_method === "remove" ||
			s.fp_method === "randomise" || s.tp_method === "randomise");
	};
	if (!wantsList(ck) && !wantsList(sc)) return;

	let list = Trace.g.CookieEater.GetList();
	if (list.indexOf(info.cookie.name) === -1) return;

	let domain = info.cookie.domain.replace(/^\./, "");
	let url = "http" + (info.cookie.secure ? "s" : "") + "://" + domain + (info.cookie.path || "/");
	if (!Whitelist.CheckList(url, "Pref_CookieEater")) return;

	chrome.cookies.remove({url:url, name:info.cookie.name, storeId:info.cookie.storeId});
	if (Trace.DEBUG) console.log("[cookd]-> Removed tracking cookie", info.cookie.name, "from", domain);
};

// ---------- statistics from matched rules (works for unpacked extensions) ----------
MV3.RuleMatched = function(info){
	let m = Rules.meta[info.rule.ruleId];
	if (!m || Vars.paused === true) return;
	if (m.kind === "block"){
		if (Prefs.Current.Main_Trace.ProtectionStats.enabled === true){
			Stats.LogStat(info.request.type);
			Tabs.LogRequest(info.request.tabId, info.request.type);
		}
	} else if (m.kind === "header" && m.log){
		Tabs.LogHeaders(info.request.tabId, m.log);
	}
};

// ---------- settings changed in storage ----------
MV3.StorageChanged = function(changes, area){
	if (area !== "local") return;
	let keys = Object.keys(changes);
	let prefKeys = Object.keys(Prefs.Defaults);

	keys.forEach(function(k){
		if (prefKeys.indexOf(k) !== -1 && changes[k].newValue !== undefined){
			// Always run the top-level action: Prefs.Set("Pref_X.enabled", ...) only
			// triggers TakeAction with the nested name, which the original switch
			// statement doesn't recognise (e.g. turning on user-agent spoofing from
			// the settings page never started the randomiser).
			Prefs.Current[k] = changes[k].newValue;
			try {
				Prefs.TakeAction(k, changes[k].newValue, false);
			} catch(e){
				console.warn("[mv3]-> TakeAction failed for", k, e);
			}
		}
		if (k === "Main_PageList" && changes[k].newValue){
			if (JSON.stringify(Whitelist.storedList) !== JSON.stringify(changes[k].newValue)){
				Whitelist.storedList = changes[k].newValue;
				Whitelist.LoadWhitelist();
			}
		}
	});
	Rules.Schedule();
};

// ---------- bridge for extension pages ----------
MV3.Snapshot = function(){
	let plain = function(obj){
		let out = {};
		Object.keys(obj).forEach(function(k){
			if (typeof obj[k] !== "function") out[k] = obj[k];
		});
		return out;
	};
	return JSON.parse(JSON.stringify({
		Prefs:{Current:Prefs.Current, Defaults:Prefs.Defaults},
		Vars:plain(Vars),
		Whitelist:{
			storedList:Whitelist.storedList,
			whitelistDefaults:Whitelist.whitelistDefaults,
			wlEnabled:Whitelist.wlEnabled,
			useTempWl:Whitelist.useTempWl,
			decodedKeySources:(Whitelist.decodedList.keys || []).map(function(r){ return r.source; }),
			decodedValues:Whitelist.decodedList.values || [],
			tempSearch:Whitelist.tempList.search || [],
			tempValues:Whitelist.tempList.values || []
		},
		Tabs:{TabList:Tabs.TabList, TabInfo:Tabs.TabInfo, ActiveTab:Tabs.ActiveTab},
		Trace:{DEBUG:Trace.DEBUG, i:{CurrentFakeIP:Trace.i.CurrentFakeIP, CurrentViaHeader:Trace.i.CurrentViaHeader}},
		Stats:{Main:Stats.Main, Current:Stats.Current},
		WebBlocker:{meta:WebBlocker.meta}
	}));
};

MV3.Resolve = function(path){
	let parts = path.split(".");
	let root = MV3.Modules[parts[0]];
	if (!root) return null;
	let owner = root, target = root;
	for (let i = 1; i < parts.length; i++){
		owner = target;
		target = target ? target[parts[i]] : undefined;
	}
	return {owner:owner, target:target, last:parts[parts.length - 1]};
};

MV3.HandleBridge = function(req, sendResponse){
	let reply = function(extra){
		let r = Object.assign({}, extra || {});
		try {
			r.snap = MV3.Snapshot();
		} catch(e){
			r.snapError = String(e);
		}
		try {
			sendResponse(r);
		} catch(e){}
	};

	if (req.op === "snapshot"){
		reply();
		return;
	}

	if (req.op === "set"){
		let res = MV3.Resolve(req.path);
		if (!res || !res.owner){
			reply({error:"Unknown path " + req.path});
			return;
		}
		res.owner[res.last] = req.value;
		if (req.path === "Vars.pauseEnd") MV3.SavePause();
		reply();
		return;
	}

	if (req.op === "call"){
		let res = MV3.Resolve(req.path);
		if (!res || typeof res.target !== "function"){
			reply({error:"Unknown function " + req.path});
			return;
		}

		let args = (req.args || []).slice();
		let cbs = req.cbIndexes || [];
		let answered = false;
		let answer = function(extra){
			if (answered) return;
			answered = true;
			// Give storage writes and rule updates a moment to settle
			setTimeout(function(){ reply(extra); }, 50);
		};

		cbs.forEach(function(i){
			args[i] = function(){
				let cbArgs;
				try {
					cbArgs = JSON.parse(JSON.stringify(Array.prototype.slice.call(arguments)));
				} catch(e){
					cbArgs = [];
				}
				answer({cbIndex:i, cbArgs:cbArgs});
			};
		});

		let ret;
		try {
			ret = res.target.apply(res.owner, args);
		} catch(e){
			answer({error:String(e)});
			return;
		}

		if (cbs.length === 0){
			Promise.resolve(ret).then(function(v){
				let safe;
				try { safe = JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch(e){ safe = null; }
				answer({ret:safe});
			}, function(e){
				answer({error:String(e)});
			});
		} else {
			// Never leave a page waiting forever
			setTimeout(function(){ answer({timeout:true}); }, 15000);
		}
	}
};

// Re-run start-up without reloading the extension (replaces background page reload)
MV3.Restart = function(){
	Trace.f.StartTrace();
};

// Any change to Vars.paused (keyboard shortcut, dashboard, popup) is saved and
// switches the request rules off or on.
(function(){
	let paused = Vars.paused;
	Object.defineProperty(Vars, "paused", {
		enumerable:true,
		configurable:true,
		get:function(){ return paused; },
		set:function(v){
			paused = v;
			if (!MV3.restoring) MV3.SavePause();
		}
	});
})();
