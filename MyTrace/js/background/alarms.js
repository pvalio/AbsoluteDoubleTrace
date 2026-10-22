var Alarms = {
	Toggle:{
		UserAgentRandomiser:function(onlyStart){
			if (Prefs.Current.Pref_UserAgent.enabled === true){
				// Create random user agent
				Alarms.Updaters.ChooseUserAgent();

				// Assign browser event
				chrome.alarms.create("UserAgentRefresh",{periodInMinutes: Vars.UserAgentInterval});
			} else {
				if (!onlyStart){
					chrome.alarms.clear("UserAgentRefresh",function(success) {
						if (!success) Trace.Notify("Failed to stop user-agent refresh process (It probably wasn't running)","uabgd");
					});
				}
			}
		},

		GPURandomiser:function(onlyStart){
			if (Prefs.Current.Pref_WebGLFingerprint.enabled === true){
				// Create random user agent
				Alarms.Updaters.ChooseGPU();

				// Assign browser event
				chrome.alarms.create("GPURefresh",{periodInMinutes: Vars.GPUInterval});
			} else {
				if (!onlyStart){
					chrome.alarms.clear("GPURefresh",function(success) {
						if (!success) Trace.Notify("Failed to stop GPU refresh process (It probably wasn't running)","gpupd");
					});
				}
			}
		}
	},

	Updaters:{
		// Modified: the GPU string now matches the spoofed browser and OS
		// (a Direct3D renderer next to a Linux or macOS user-agent is a giveaway),
		// and the unmasked vendor matches the GPU brand.
		ChooseGPU:function(){
			if (Prefs.Current.Pref_WebGLFingerprint.enabled === false) return;

			let gpuStr = rA(Vars.gpuModels);
			if (Prefs.Current.Pref_WebGLFingerprint.gpuList.list.length !== 0){
				gpuStr = rA(Prefs.Current.Pref_WebGLFingerprint.gpuList.list);
			}

			// Match the spoofed identity, or the real browser if UA spoofing is off
			let fam = Vars.uaFamily, platName = Vars.uaPlatformName;
			if (Prefs.Current.Pref_UserAgent.enabled !== true){
				let real = Alarms.Updaters.DescribeUserAgent(navigator.userAgent);
				fam = real.family;
				platName = real.platformName;
			}

			let brand = "Intel";
			if (/nvidia|geforce|quadro/i.test(gpuStr)) brand = "NVIDIA";
			else if (/amd|ati |radeon/i.test(gpuStr)) brand = "AMD";

			if (platName === "macOS"){
				brand = "Apple";
				gpuStr = rA(["Apple M1", "Apple M2", "Apple M3"]);
				Vars.gpuChose = "ANGLE (Apple, ANGLE Metal Renderer: " + gpuStr + ", Unspecified Version)";
			} else if (platName === "Linux"){
				Vars.gpuChose = "ANGLE (" + brand + ", " + gpuStr + ", OpenGL 4.6)";
			} else {
				Vars.gpuChose = "ANGLE (" + brand + ", " + gpuStr + " Direct3D11 vs_5_0 ps_5_0, D3D11)";
			}

			Vars.gpuVendor = "Google Inc. (" + brand + ")";
			if (fam === "safari"){
				// Safari doesn't use the ANGLE naming
				Vars.gpuVendor = "Apple Inc.";
				Vars.gpuChose = "Apple GPU";
			}

			if (fam === "firefox"){
				Vars.glVendor = "Mozilla";
				Vars.glRenderer = "Mozilla";
			} else {
				Vars.glVendor = "WebKit";
				Vars.glRenderer = "WebKit WebGL";
			}
		},

		// Fill in the values that go with a user-agent string, so that
		// navigator.platform, vendor, oscpu and client hints all agree with it.
		DescribeUserAgent:function(ua){
			let d = {
				family:"chromium", brand:"Google Chrome", major:"0",
				platform:"Win32", platformName:"Windows", vendor:"Google Inc.", oscpu:""
			};

			if (/Macintosh|Mac OS X/i.test(ua)){
				d.platform = "MacIntel"; d.platformName = "macOS"; d.oscpu = "Intel Mac OS X 10.15";
			} else if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)){
				d.platform = "Linux x86_64"; d.platformName = "Linux"; d.oscpu = "Linux x86_64";
			} else {
				d.platform = "Win32"; d.platformName = "Windows"; d.oscpu = "Windows NT 10.0; Win64; x64";
			}

			let m;
			if ((m = ua.match(/Firefox\/(\d+)/))){
				d.family = "firefox"; d.brand = "Firefox"; d.vendor = ""; d.major = m[1];
			} else if ((m = ua.match(/Edg\/(\d+)/))){
				d.family = "chromium"; d.brand = "Microsoft Edge"; d.major = m[1];
			} else if ((m = ua.match(/Chrome\/(\d+)/))){
				d.family = "chromium"; d.brand = "Google Chrome"; d.major = m[1];
			} else if ((m = ua.match(/Version\/(\d+)[\d.]* Safari/))){
				d.family = "safari"; d.brand = "Safari"; d.vendor = "Apple Computer, Inc."; d.major = m[1];
			}

			return d;
		},

		ApplyUserAgent:function(ua){
			let d = Alarms.Updaters.DescribeUserAgent(ua);

			Vars.useragent = ua;
			Vars.platform = d.platform;
			Vars.vendor = d.vendor;
			Vars.uaFamily = d.family;
			Vars.uaBrand = d.brand;
			Vars.uaMajor = d.major;
			Vars.uaPlatformName = d.platformName;
			// navigator.oscpu only exists in Firefox
			Vars.oscpu = (d.family === "firefox" ? d.oscpu : "");

			// Keep the WebGL GPU consistent with the new OS
			Alarms.Updaters.ChooseGPU();
		},

		ChooseUserAgent:function(){
			let cfg = Prefs.Current.Pref_UserAgent;

			// If user has enabled custom user agents and set some.
			// Bug fix: the original returned the custom UA here without ever applying it.
			if (cfg.uaCust.enabled === true && cfg.uaCust.customUAs.length > 0){
				Alarms.Updaters.ApplyUserAgent(rA(cfg.uaCust.customUAs));
				return;
			}

			let os = Vars.uaSettings.os, ver = Vars.uaSettings.versions;

			let osPool = [];
			if (cfg.uaOSConfig.AllowWindows.enabled === true) osPool.push(["windows", os.windows["Windows 10/11 (x64)"]]);
			if (cfg.uaOSConfig.AllowMac.enabled === true) osPool.push(["macos", os.macos["macOS"]]);
			if (cfg.uaOSConfig.AllowLinux.enabled === true) osPool.push(["linux", os.linux["Linux x86_64"]]);

			let wb = cfg.uaWBConfig, wbPool = [];
			if (wb.AllowChrome.enabled === true) wbPool.push("chrome");
			if (wb.AllowVivaldi && wb.AllowVivaldi.enabled === true) wbPool.push("chrome");	// Vivaldi sends a plain Chrome UA
			if (wb.AllowFirefox.enabled === true) wbPool.push("firefox");
			if (wb.AllowEdge.enabled === true) wbPool.push("edge");
			if (wb.AllowSafari.enabled === true) wbPool.push("safari");

			// Only build combinations that exist in the real world
			let combos = [];
			osPool.forEach(function(o){
				wbPool.forEach(function(b){
					if (b === "safari" && o[0] !== "macos") return;
					combos.push([o, b]);
				});
			});

			if (combos.length === 0){
				// Nothing allowed: keep the current (consistent) values
				Alarms.Updaters.ApplyUserAgent(Vars.useragent);
				return;
			}

			let pick = rA(combos), osKey = pick[0][0], osToken = pick[0][1], b = pick[1];
			let v = rA(ver[b === "chrome" ? "chrome" : b]);
			let ua;

			if (b === "firefox"){
				let ffOs = (osKey === "macos" ? "Macintosh; Intel Mac OS X 10.15" : osToken);
				ua = "Mozilla/5.0 (" + ffOs + "; rv:" + v + ".0) Gecko/20100101 Firefox/" + v + ".0";
			} else if (b === "safari"){
				ua = "Mozilla/5.0 (" + osToken + ") AppleWebKit/605.1.15 (KHTML, like Gecko) Version/" + v + " Safari/605.1.15";
			} else {
				ua = "Mozilla/5.0 (" + osToken + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + v + ".0.0.0 Safari/537.36";
				if (b === "edge") ua += " Edg/" + v + ".0.0.0";
			}

			Alarms.Updaters.ApplyUserAgent(ua);
		}
	},

	Start:function(){
		if (!chrome.alarms) {
			console.error("Alarms aren't supported in this browser.");
			return false;
		}

		// MV3: the onAlarm listener is registered by js/mv3/sw.js
		try{
		} catch(e){
			if (e.message){
				console.log(e.message);
			} else {
				console.warn("Error starting alarm events, mabye browser doesn't support them?");
			}
		}
	},

	Event:function(a){
		switch (a.name){
			case "UserAgentRefresh":
				if (Prefs.Current.Pref_UserAgent.enabled === true) Alarms.Updaters.ChooseUserAgent();
				break;
			case "GPURefresh":
				if (Prefs.Current.Pref_WebGLFingerprint.enabled === true) Alarms.Updaters.ChooseGPU();
				break;
			case "StatsDatabaseRefresh":
				if (Prefs.Current.Main_Trace.ProtectionStats.enabled === true) Stats.SaveStats();
				break;
			case "UserFakeIPRefresh":
				if (Prefs.Current.Pref_IPSpoof.enabled !== true || Prefs.Current.Pref_IPSpoof.traceIP.enabled === true){
					Trace.i.StopIPRefresh();
					break;
				}
				Trace.i.RefreshFakeUserIP();
				break;
			default:
				console.warn("Unknown alarm: " + a.name);
				break;
		}
	}
};