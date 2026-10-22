/*
 * 	Trace page helper script for before documents load
 * 	Copyright AbsoluteDouble 2018 - 2020
 * 	Written by Jake Mcneill
 * 	https://absolutedouble.co.uk/
 */

// A general fix for browser that use window.browser instead of window.chrome
if (typeof window.chrome === "undefined" || !window.chrome.hasOwnProperty("extension")) window.chrome = (function (){ return window.msBrowser || window.browser || window.chrome; })();

var TPage = {
	Settings:{
		prefix:"tp_",
		Prefs:{},
		Additional:{},
		Whitelist:{},
		Exec:{},
		Queue:[],
		RunProtections:[
			"Pref_AudioFingerprint",
			"Pref_BatteryApi",
			"Pref_CanvasFingerprint",
			// "Pref_CommonTracking",
			"Pref_ClientRects",
			// "Pref_FontFingerprint",
			"Pref_HardwareSpoof",
			"Pref_NativeFunctions",
			"Pref_NetworkInformation",
			"Pref_PingBlock",
			"Pref_PluginHide",
			"Pref_ReferHeader",
			"Pref_ScreenRes",
			"Pref_UserAgent",
			"Pref_WebGLFingerprint",
			"Pref_WebRTC"
		]
	},

	css:"font-size:1em;line-height:1.4em;color:#fff;background-color:#1a1a1a;border:.1em solid #00af00;",

	startTracePage:function(){
		let pageUrl = window.location.href || document.location.href;
		try {
			pageUrl = window.top.location.href;
		} catch(e) {  }

		// https://bugs.chromium.org/p/chromium/issues/detail?id=54257
		chrome.runtime.sendMessage({
			msg:"tracepage",
			url:pageUrl
		},TPage.init);

		// Listen for protection notifications
		TPage.assignMessageListener();
	},

	assignMessageListener:function() {
		window.addEventListener("message", function (e) {
			if (!e || !e.data || !e.type) return;
			if (typeof e.data !== "string") return;
			if (e.data.indexOf("trace-protection::") === -1) return;

			let parts = e.data.split("::");
			if (parts.length !== 4) return;

			chrome.runtime.sendMessage({
				msg:"protectionRan",
				url: document.location.href,
				update:parts[1],
				protection:parts[2],
				part:parts[3]
			});
		}, false);
	},

	// Call with data loaded from background page
	init:function(data){
		if (data.tracePaused === true){
			console.log("%c Trace Paused.",TPage.css);
			return;
		}

		TPage.Settings.Additional = data.additional;
		TPage.Settings.Prefs = data.prefs;
		TPage.Settings.Whitelist = data.data;

		TPage.runProtections();
	},

	page: {
		runInjection:function(protCode, protParams, protName){
			// MV3: queue the protection; page-main.js runs it in the page's world
			TPage.Settings.Queue.push({name:protName, params:protParams});
			TPage.Settings.Exec[protName] = true;

		}
	},

	runProtections:function(){
		// TPage.Settings.Prefs["Pref_FontFingerprint"] = {"enabled":true};
		let protectionKeys = Object.keys(TPage.Settings.Prefs);

		console.group("Trace Protections");
		for (let i = 0; i<protectionKeys.length; i++){
			let protection = protectionKeys[i];

			// Check if the protection is one of the allowed
			if (TPage.Settings.RunProtections.indexOf(protection) === -1){
				continue;
			}

			let host = window.location.hostname || "Unknown Host";

			// Check if setting is allowed to run from whitelist
			if (TPage.Settings.Whitelist[protection] === false){
				console.warn(protection + " cannot execute due to whitelist rule on: " + host);
				continue;
			}

			// Check setting is enabled in preferences
			if (!TPage.Settings.Prefs[protection]["enabled"]){
				console.log("%c Protection is not enabled: " + protection,"font-size:1em;line-height:1.5em;color:amber;");
				continue;
			}

			// Check if the protection has already run
			if (TPage.Settings.Exec[protection]){
				console.error("Protection has already ran: " + protection);
				continue;
			}


			// Check if we need to add any settings from background page
			let tempParams = TPage.Settings.Prefs[protection];
			if (TPage.Settings.Additional[protection]){
				tempParams = Object.assign(tempParams, TPage.Settings.Additional[protection]);
			}
			let params = JSON.stringify(tempParams);

			// Run protection code
			let protFunc = null;
			console.log("%c" + protection + " has run on: " + host,"font-size:1em;line-height:1.5em;color:green;");

			TPage.page.runInjection(protFunc, params, protection);
		}
		console.groupEnd();

		// Hand everything to page-main.js in one go
		document.dispatchEvent(new CustomEvent("trace-mv3-run", {
			detail:JSON.stringify(TPage.Settings.Queue)
		}));
	},

	// Protection code now lives in page-main.js (MAIN world).


	/*
	protectAudioFinger:function(){
		var opts = {
			audioBuffer:{enabled:TPage.Prefs.BlockAudioFinger.audioBuffer.enabled},
			audioData:{enabled:TPage.Prefs.BlockAudioFinger.audioData.enabled},
			audioOfflineMain:{enabled:TPage.Prefs.BlockAudioFinger.audioOfflineMain.enabled},
			audioMain:{enabled:TPage.Prefs.BlockAudioFinger.audioMain.enabled}
		};

		// If nothing is enabled just don't run the protection
		if (opts["audioBuffer"]["enabled"] !== true && opts["audioData"]["enabled"] !== true && opts["audioMain"]["enabled"] !== true){
			return;
		}

		TPage.codeNewPreInject(
			function(opts){
				return opts;
			},
			function(frame,opts){
				var opts = JSON.parse(opts);

				// Get those Objects
				var ab = frame.AudioBuffer;
				var an = frame.AnalyserNode;
				var ae = frame;

				if (opts["audioBuffer"]["enabled"] === true) {
					ab.prototype.copyFromChannel = function(){console.log("%c [Tr]Blocked [AF][CF] Audio Tracking ","font-size:1em;line-height:2em;color:#1a1a1a;background-color:#ffffff;border:.2em solid #0f0;");return false;};
					ab.prototype.getChannelData = function(){console.log("%c [Tr]Blocked [AF][CD] Audio Tracking ","font-size:1em;line-height:2em;color:#1a1a1a;background-color:#ffffff;border:.2em solid #0f0;");return false;};
				}
				if (opts["audioData"]["enabled"] === true){
					an.prototype.getFloatFrequencyData = function(){console.log("%c [Tr]Blocked [AF][FF] Audio Tracking ","font-size:1em;line-height:2em;color:#1a1a1a;background-color:#ffffff;border:.2em solid #0f0;"); return false;};
					an.prototype.getByteFrequencyData = function(){console.log("%c [Tr]Blocked [AF][BF] Audio Tracking ","font-size:1em;line-height:2em;color:#1a1a1a;background-color:#ffffff;border:.2em solid #0f0;"); return false;};
					an.prototype.getFloatTimeDomainData = function(){console.log("%c [Tr]Blocked [AF][TD] Audio Tracking ","font-size:1em;line-height:2em;color:#1a1a1a;background-color:#ffffff;border:.2em solid #0f0;"); return false;};
					an.prototype.getByteTimeDomainData = function(){console.log("%c [Tr]Blocked [AF][BT] Audio Tracking ","font-size:1em;line-height:2em;color:#1a1a1a;background-color:#ffffff;border:.2em solid #0f0;"); return false;};
				}
				if (opts["audioOfflineMain"]["enabled"] === true){
					ae.OfflineAudioContext = function(){console.log("%c [Tr]Blocked [AF][AO] Audio tracking ","font-size:1em;line-height:2em;color:#1a1a1a;background-color:#ffffff;border:.2em solid #0f0;"); return {};};
					ae.webkitOfflineAudioContext = function(){console.log("%c [Tr]Blocked [AF][WO] Audio tracking ","font-size:1em;line-height:2em;color:#1a1a1a;background-color:#ffffff;border:.2em solid #0f0;"); return {};};
				}
				if (opts["audioMain"]["enabled"] === true){
					ae.AudioContext = function(){console.log("%c [Tr]Blocked [AF][AC] Audio tracking ","font-size:1em;line-height:2em;color:#1a1a1a;background-color:#ffffff;border:.2em solid #0f0;"); return {};};
					ae.webkitAudioContext = function(){console.log("%c [Tr]Blocked [AF][WA] Audio tracking ","font-size:1em;line-height:2em;color:#1a1a1a;background-color:#ffffff;border:.2em solid #0f0;"); return {};};
				}
			},"'" + JSON.stringify(opts) + "'",true
		);
	}
	*/
};

// Let's begin
TPage.startTracePage();