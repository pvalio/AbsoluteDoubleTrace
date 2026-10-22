/*
 * Trace MV3: declarativeNetRequest rules.
 *
 * Manifest V3 removed blocking webRequest, so the code that used to inspect
 * and change every request (web.js RequestChecker, headers.js Modify functions)
 * is replaced by rules that the browser applies itself. Rules are rebuilt from
 * the current settings, whitelist, blocklist and spoofed identity whenever any
 * of them change.
 *
 * What maps 1:1:  domain/host/TLD/URL/file blocking, the "blocked" page, ping
 * blocking, URL tracking-parameter removal, User-Agent + client hints, E-Tag,
 * Google headers, proxy-IP headers, referer removal, removing all cookies.
 * What doesn't (no MV3 equivalent): changing referers to "hostname only",
 * randomising cookie values and URL parameters (these fall back to removing).
 * Removing specific named cookies is done with the cookies API (overrides.js).
 */
var Rules = {
	timer:null,
	meta:{},		// rule id -> {kind:"block"} or {kind:"header", log:"useragent"...}

	ALL_TYPES:["main_frame","sub_frame","stylesheet","script","image","font","object","xmlhttprequest","ping","csp_report","media","websocket","other"],
	SUB_TYPES:["sub_frame","stylesheet","script","image","font","object","xmlhttprequest","ping","csp_report","media","websocket","other"],

	Schedule:function(){
		clearTimeout(Rules.timer);
		Rules.timer = setTimeout(Rules.Apply, 200);
	},

	// ---------- whitelist helpers ----------

	// Turn a whitelist pattern like "*example.com*" or "https://*.example.com/*"
	// into a domain declarativeNetRequest understands (it also covers subdomains).
	PatternToDomain:function(pattern){
		if (typeof pattern !== "string") return null;
		let s = pattern.trim().toLowerCase();
		s = s.replace(/^\*+/, "").replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*?\.?/, "");
		s = s.split(/[\/*?:#]/)[0];
		return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
	},

	WhitelistEntries:function(){
		let out = [];
		let stored = Whitelist.storedList || {};
		Object.keys(stored).forEach(function(k){
			let d = Rules.PatternToDomain(k);
			if (d && stored[k]) out.push({domain:d, value:stored[k]});
		});
		let t = Whitelist.tempList || {search:[], values:[]};
		(t.search || []).forEach(function(k, i){
			let d = Rules.PatternToDomain(k);
			if (d && t.values[i]) out.push({domain:d, value:t.values[i]});
		});
		return out;
	},

	// Add the whitelist to a rule condition for one protection.
	// Mirrors Whitelist.CheckList: protections in "AllPage" run everywhere except
	// sites where they're switched off; "PerPage" ones only run where switched on.
	ScopeCondition:function(protection, condition){
		let allPage = Prefs.Current.Main_ExecutionOrder.AllPage.indexOf(protection) !== -1;
		let off = [], on = [];

		Rules.WhitelistEntries().forEach(function(e){
			if (!e.value.Protections) return;
			(e.value.Protections[protection] ? on : off).push(e.domain);
		});

		if (allPage){
			if (off.length) condition.excludedRequestDomains = (condition.excludedRequestDomains || []).concat(off);
			return condition;
		}
		if (on.length === 0) return null;
		condition.requestDomains = on;
		return condition;
	},

	// ---------- rule builders ----------

	Build:function(){
		let rules = [], meta = {}, nextId = 1;
		let P = Prefs.Current;

		let add = function(rule, info){
			if (!rule || !rule.condition) return;
			rule.id = nextId++;
			if (!rule.priority) rule.priority = 1;
			rules.push(rule);
			meta[rule.id] = info || {kind:"other"};
		};

		let headerRule = function(protection, requestHeaders, responseHeaders, log, extra){
			let condition = Object.assign({resourceTypes:Rules.ALL_TYPES}, extra || {});
			condition = Rules.ScopeCondition(protection, condition);
			if (!condition) return;
			let action = {type:"modifyHeaders"};
			if (requestHeaders && requestHeaders.length) action.requestHeaders = requestHeaders;
			if (responseHeaders && responseHeaders.length) action.responseHeaders = responseHeaders;
			add({action:action, condition:condition}, {kind:"header", log:log});
		};

		// ----- Web controller: blocklist -----
		if (P.Pref_WebController.enabled === true){
			let valid = function(d){ return typeof d === "string" && /^[a-z0-9.-]+$/.test(d) && d.indexOf("..") === -1; };
			let siteAllowed = [], initAllowed = [], siteForced = [];
			Rules.WhitelistEntries().forEach(function(e){
				if (e.value.SiteBlocked === false) siteAllowed.push(e.domain);
				if (e.value.SiteBlocked === true) siteForced.push(e.domain);
				if (e.value.InitRequests === true) initAllowed.push(e.domain);
			});

			let blockDomains = []
				.concat(WebBlocker.blocked.domain || [], WebBlocker.blocked.host || [], WebBlocker.blocked.tld || [], siteForced)
				.map(function(d){ return String(d).toLowerCase(); })
				.filter(valid);
			// de-duplicate
			blockDomains = blockDomains.filter(function(d, i, a){ return a.indexOf(d) === i; });

			let exclusions = function(cond){
				if (siteAllowed.length) cond.excludedRequestDomains = siteAllowed.slice();
				if (initAllowed.length) cond.excludedInitiatorDomains = initAllowed.slice();
				return cond;
			};

			if (blockDomains.length){
				// Page loads go to Trace's "blocked" page with the original URL
				add({
					priority:2,
					action:{type:"redirect", redirect:{regexSubstitution:chrome.runtime.getURL("html/blocked.html") + "#dnr;\\0"}},
					condition:exclusions({requestDomains:blockDomains, regexFilter:"^https?://.*", resourceTypes:["main_frame"]})
				}, {kind:"block"});

				add({
					priority:2,
					action:{type:"block"},
					condition:exclusions({requestDomains:blockDomains, resourceTypes:Rules.SUB_TYPES})
				}, {kind:"block"});
			}

			(WebBlocker.blocked.url || []).forEach(function(u){
				if (typeof u !== "string" || u.length < 4 || u.indexOf("*") !== -1) return;
				add({
					priority:2,
					action:{type:"block"},
					condition:exclusions({urlFilter:"||" + u.toLowerCase(), resourceTypes:Rules.ALL_TYPES})
				}, {kind:"block"});
			});

			(WebBlocker.blocked.file || []).forEach(function(f){
				if (typeof f !== "string" || f.length < 3 || f.indexOf("*") !== -1) return;
				add({
					priority:2,
					action:{type:"block"},
					condition:exclusions({urlFilter:"/" + f, resourceTypes:Rules.ALL_TYPES})
				}, {kind:"block"});
			});

			// ----- URL cleaner (tracking parameters / fragments) -----
			let uc = P.Pref_WebController.urlCleaner;
			if (uc && uc.enabled === true){
				let transform = {};
				if (uc.fragmentHash && uc.fragmentHash.enabled === true) transform.fragment = "";

				let qs = uc.queryString;
				if (qs && qs.enabled === true && qs.main_frame && qs.main_frame.level !== -1){
					if (qs.main_frame.level === 4){
						transform.query = "";
					} else {
						let params = Trace.g.URLCleaner.GetList("main_frame").filter(function(p){ return typeof p === "string"; });
						if (params.length) transform.queryTransform = {removeParams:params};
					}
				}

				if (Object.keys(transform).length){
					let cond = {urlFilter:"|http", resourceTypes:["main_frame","sub_frame"]};
					if (siteAllowed.length) cond.excludedRequestDomains = siteAllowed.slice();
					add({action:{type:"redirect", redirect:{transform:transform}}, condition:cond}, {kind:"other"});
				}
			}
		}

		// ----- Ping / beacon blocking -----
		if (P.Pref_PingBlock.enabled === true && P.Pref_PingBlock.pingRequest.enabled === true){
			let cond = Rules.ScopeCondition("Pref_PingBlock", {resourceTypes:["ping"]});
			if (cond) add({priority:2, action:{type:"block"}, condition:cond}, {kind:"block"});
		}

		// ----- User-Agent and client hints -----
		if (P.Pref_UserAgent.enabled === true && typeof Vars.useragent === "string" && Vars.useragent.length){
			let h = [{header:"user-agent", operation:"set", value:Vars.useragent}];
			let highEntropy = ["sec-ch-ua-arch","sec-ch-ua-bitness","sec-ch-ua-full-version","sec-ch-ua-full-version-list",
				"sec-ch-ua-model","sec-ch-ua-platform-version","sec-ch-ua-wow64","sec-ch-ua-form-factors"];

			if (Vars.uaFamily === "chromium"){
				h.push({header:"sec-ch-ua", operation:"set",
					value:'"Not.A/Brand";v="99", "Chromium";v="' + Vars.uaMajor + '", "' + Vars.uaBrand + '";v="' + Vars.uaMajor + '"'});
				h.push({header:"sec-ch-ua-mobile", operation:"set", value:"?0"});
				h.push({header:"sec-ch-ua-platform", operation:"set", value:'"' + Vars.uaPlatformName + '"'});
			} else {
				["sec-ch-ua","sec-ch-ua-mobile","sec-ch-ua-platform"].forEach(function(n){
					h.push({header:n, operation:"remove"});
				});
			}
			highEntropy.forEach(function(n){ h.push({header:n, operation:"remove"}); });

			headerRule("Pref_UserAgent", h, null, "useragent");
		}

		// ----- E-Tag -----
		if (P.Pref_ETagTrack.enabled === true){
			headerRule("Pref_ETagTrack", null, [{header:"etag", operation:"remove"}], "etag");
		}

		// ----- Google headers -----
		let g = P.Pref_GoogleHeader;
		if (g.enabled === true){
			let rm = [];
			if (g.rmChromeConnected.enabled === true) rm.push("x-chrome-connected");
			if (g.rmChromeUMA.enabled === true) rm.push("x-chrome-uma-enabled");
			if (g.rmChromeVariations.enabled === true) rm.push("x-chrome-variations");
			if (g.rmClientData.enabled === true) rm.push("x-client-data");
			if (rm.length){
				headerRule("Pref_GoogleHeader", rm.map(function(n){ return {header:n, operation:"remove"}; }), null, "google");
			}
		}

		// ----- Proxy IP headers -----
		let ip = P.Pref_IPSpoof;
		if (ip.enabled === true && typeof Trace.i.CurrentFakeIP === "string"){
			let h = [];
			if (ip.useClientIP.enabled === true) h.push({header:"client-ip", operation:"set", value:Trace.i.CurrentFakeIP});
			if (ip.useForwardedFor.enabled === true){
				h.push({header:"x-forwarded-for", operation:"set", value:Trace.i.CurrentFakeIP});
				h.push({header:"via", operation:"set", value:Trace.i.CurrentViaHeader || "Proxy"});
			}
			if (h.length) headerRule("Pref_IPSpoof", h, null, "proxyip");
		}

		// ----- Referer -----
		let r = P.Pref_ReferHeader;
		if (r.enabled === true){
			let rmRef = [{header:"referer", operation:"remove"}];
			if (r.httpHeader.onlySecureOrigins.enabled === true){
				headerRule("Pref_ReferHeader", rmRef, null, "referer", {urlFilter:"|http://"});
			}
			if (r.httpHeader.allowThirdParty.enabled !== true){
				headerRule("Pref_ReferHeader", rmRef, null, "referer", {domainType:"thirdParty"});
			}
			if (r.httpHeader.allowSameDomain.enabled !== true && r.httpHeader.allowSameHost.enabled !== true){
				headerRule("Pref_ReferHeader", rmRef, null, "referer", {domainType:"firstParty"});
			}
		}

		// ----- Cookies (remove all) -----
		let c = P.Pref_CookieEater;
		if (c.enabled === true){
			let ck = c.settings.cookie, sc = c.settings.setcookie;
			[["firstParty","fp_method"],["thirdParty","tp_method"]].forEach(function(pair){
				if (ck.enabled === true && (ck[pair[1]] === "removeall" || ck[pair[1]] === "randomiseall")){
					headerRule("Pref_CookieEater", [{header:"cookie", operation:"remove"}], null, "cookies", {domainType:pair[0]});
				}
				if (sc.enabled === true && (sc[pair[1]] === "removeall" || sc[pair[1]] === "randomiseall")){
					headerRule("Pref_CookieEater", null, [{header:"set-cookie", operation:"remove"}], "setcookie", {domainType:pair[0]});
				}
			});
		}

		return {rules:rules, meta:meta};
	},

	Apply:async function(){
		let built = (Vars.paused === true) ? {rules:[], meta:{}} : Rules.Build();
		Rules.meta = built.meta;

		try {
			let existing = await chrome.declarativeNetRequest.getDynamicRules();
			let removeRuleIds = existing.map(function(r){ return r.id; });

			try {
				await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:removeRuleIds, addRules:built.rules});
			} catch(e){
				// One bad rule rejects the whole batch: add them one by one and skip the bad ones
				console.warn("[Trace rules] Batch update failed, adding rules individually:", e.message);
				await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:removeRuleIds});
				for (let i = 0; i < built.rules.length; i++){
					try {
						await chrome.declarativeNetRequest.updateDynamicRules({addRules:[built.rules[i]]});
					} catch(err){
						console.warn("[Trace rules] Skipped rule", built.rules[i], err.message);
						delete Rules.meta[built.rules[i].id];
					}
				}
			}
			if (Trace.DEBUG) console.log("[rules]-> Applied", built.rules.length, "rules");
		} catch(e){
			console.error("[Trace rules] Couldn't update rules:", e);
		}
	}
};
