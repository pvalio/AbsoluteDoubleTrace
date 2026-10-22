/*
 * Trace MV3 service worker.
 *
 * Loads the original background modules, adapts them (js/mv3/overrides.js,
 * js/mv3/rules.js) and registers every event listener synchronously at start-up,
 * which Manifest V3 requires so events that wake the worker aren't lost.
 * Handlers wait until settings have loaded (MV3.ready) before running.
 */

// The original modules expect a window
self.window = self;
self.alert = function(msg){ console.error("[Trace]", msg); };
self.TraceBg = function(cb){ cb(self); };

var MV3 = {
	restoring:true,
	identityRestored:false,
	markReady:null
};
MV3.ready = new Promise(function(resolve){ MV3.markReady = resolve; });

importScripts(
	"/js/libraries/cookieparse.js",
	"/js/common/data.js",
	"/js/common/shared.js",
	"/js/background/background.js",
	"/js/background/vars.js",
	"/js/background/alarms.js",
	"/js/background/headers.js",
	"/js/background/prefs.js",
	"/js/background/session.js",
	"/js/background/simple.js",
	"/js/background/stats.js",
	"/js/background/tabs.js",
	"/js/background/web.js",
	"/js/background/whitelist.js",
	"/js/background/trace.js",
	"/js/mv3/rules.js",
	"/js/mv3/overrides.js"
);

// Run a handler once start-up has finished
var whenReady = function(fn){
	return function(){
		let args = arguments;
		MV3.ready.then(function(){
			try {
				fn.apply(null, args);
			} catch(e){
				console.error("[Trace]", e);
			}
		});
	};
};

// ---------- event listeners (top level, synchronous) ----------
chrome.runtime.onInstalled.addListener(whenReady(function(details){
	Trace.a.NewInstall(details);
}));

chrome.runtime.onMessage.addListener(function(req, sender, sendResponse){
	if (req && req.msg === "mv3-bg"){
		MV3.ready.then(function(){ MV3.HandleBridge(req, sendResponse); });
		return true;
	}
	MV3.ready.then(function(){ Trace.a.ContentTalk(req, sender, sendResponse); });
	return true;
});

// Simple dashboard (settings.html) talks over a port; keep early messages
chrome.runtime.onConnect.addListener(function(port){
	let queue = [];
	let early = function(msg){ queue.push(msg); };
	port.onMessage.addListener(early);
	MV3.ready.then(function(){
		Simple.port = port;
		port.onMessage.removeListener(early);
		port.onMessage.addListener(Simple.receive);
		queue.forEach(function(m){ Simple.receive(m); });
	});
});

chrome.alarms.onAlarm.addListener(whenReady(function(alarm){ Alarms.Event(alarm); }));

if (chrome.commands){
	chrome.commands.onCommand.addListener(whenReady(function(c){ Trace.f.KeyboardCommand(c); }));
}

["onRemoved","onCreated","onActivated","onHighlighted","onUpdated"].forEach(function(evt){
	let name = evt.substring(2).toLowerCase();		// onRemoved -> removed
	if (name === "activated") name = "activate";
	if (name === "highlighted") name = "highlight";
	chrome.tabs[evt].addListener(whenReady(function(){
		if (Tabs.TabInfo !== true || !Tabs.Events[name]) return;
		Tabs.Events[name].apply(null, arguments);
	}));
});

chrome.storage.onChanged.addListener(whenReady(function(changes, area){ MV3.StorageChanged(changes, area); }));

if (chrome.cookies){
	chrome.cookies.onChanged.addListener(whenReady(function(info){ MV3.CookieChanged(info); }));
}

// Only available to unpacked extensions with declarativeNetRequestFeedback;
// used for the blocked-request statistics and the popup's per-tab counters.
if (chrome.declarativeNetRequest.onRuleMatchedDebug){
	chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(whenReady(function(info){ MV3.RuleMatched(info); }));
}

// ---------- start-up ----------
(function(){
	let origStart = Trace.f.StartModules;
	Trace.f.StartModules = function(){
		origStart.apply(this, arguments);

		if (MV3.restoring){
			// Restore the temporary whitelist and per-tab counters
			(MV3.savedTempWl || []).forEach(function(item){ Whitelist.AddTempItem(item); });
			if (MV3.savedTabs && typeof MV3.savedTabs === "object"){
				Object.keys(MV3.savedTabs).forEach(function(id){
					if (Tabs.TabList[id]) Tabs.TabList[id] = MV3.savedTabs[id];
				});
			}
			MV3.restoring = false;
			if (!MV3.identityRestored) MV3.SaveIdentity();
		}

		Rules.Schedule();
		MV3.markReady();
	};
})();

Trace.a.AssignRuntime();

chrome.storage.session.get(["mv3_identity","mv3_pause","mv3_tempwl","mv3_tabs"], function(s){
	s = s || {};
	MV3.identityRestored = MV3.RestoreIdentity(s.mv3_identity);
	if (s.mv3_pause){
		Vars.paused = s.mv3_pause.paused === true;
		Vars.pauseEnd = s.mv3_pause.pauseEnd || 0;
	}
	MV3.savedTempWl = s.mv3_tempwl || [];
	MV3.savedTabs = s.mv3_tabs || null;

	Trace.f.StartTrace();
});
