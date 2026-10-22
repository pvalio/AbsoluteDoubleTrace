var Vars = {
	// From storage
	eReporting:false,
	bNotifications:false,
	pSessions:false,
	sessionData:{},
	Premium:"",

	// Trace Presets
	usePresets:false,
	preset:2,

	// Trace pausing
	paused:false,
	pauseEnd:0,

	// Refresh constants
	// Modified: was 1 minute. Changing identity every minute in the middle of a
	// session is itself a strong signal and breaks logins; rotate hourly instead.
	UserAgentInterval:60,
	GPUInterval:60,
	FakeIPInterval:1,


	// Remote services (modified): off by default, see web.js BlocklistLoader.
	// Re-enabling also requires adding the hosts back to connect-src in the manifest CSP.
	remoteBlocklist:false,

	// Blocklist URLs
	blocklistURL:"https://trace-extension.absolutedouble.co.uk/app/weblist.php",
	blocklistFallback:"https://raw.githubusercontent.com/jake-cryptic/hmfp_lists/master/fallback.json",
	blocklistOffline:(chrome.hasOwnProperty("extension") ? chrome.runtime.getURL("data/blocklist.json") : browser.extension.getURL("data/blocklist.json")),
	blocklistBase:"https://trace-extension.absolutedouble.co.uk/app/weblist.php?p=",
	appSecret:"Cza7kImqFYZPrbGq76PY8I9fynasuWyEoDtY4L9U0zgIACb2t9vpn2sO4eHcS0Co",		// Is this pointless? Yes. Do I care? No.
	serverNames:{
		0:"main",
		1:"GitHub",
		2:"local",
		3:"cache"
	},

	// Blocker Vars
	listCompat:"210",
	callbacks:[],

	// Notification constant
	notifIcon:"icons/trace_256.png",

	// User agent values (modified): current browser versions, and only
	// combinations that real browsers actually send. Update the version
	// lists every few months, since stale versions stand out.
	uaSettings:{
		"os":{
			"windows":{"Windows 10/11 (x64)":"Windows NT 10.0; Win64; x64"},
			"linux":{"Linux x86_64":"X11; Linux x86_64"},
			"macos":{"macOS":"Macintosh; Intel Mac OS X 10_15_7"}
		},
		"versions":{
			"chrome":["155","154"],
			"edge":["155","154"],
			"firefox":["158","157"],
			"safari":["26.0","18.6"]
		}
	},

	// Modified: GPUs people actually use with current browsers. The old list
	// was mostly 2008-2015 hardware, which a Chrome 15x user-agent can't plausibly run on.
	gpuModels: [
		'NVIDIA GeForce GTX 1650',
		'NVIDIA GeForce GTX 1660 SUPER',
		'NVIDIA GeForce RTX 2060',
		'NVIDIA GeForce RTX 3050',
		'NVIDIA GeForce RTX 3060',
		'NVIDIA GeForce RTX 3060 Laptop GPU',
		'NVIDIA GeForce RTX 3070',
		'NVIDIA GeForce RTX 4060',
		'NVIDIA GeForce RTX 4060 Laptop GPU',
		'NVIDIA GeForce RTX 4070',
		'AMD Radeon RX 580 Series',
		'AMD Radeon RX 6600',
		'AMD Radeon RX 6700 XT',
		'AMD Radeon RX 7600',
		'AMD Radeon(TM) Graphics',
		'Intel(R) UHD Graphics 620',
		'Intel(R) UHD Graphics 630',
		'Intel(R) UHD Graphics 770',
		'Intel(R) Iris(R) Xe Graphics'
	],
	gpuChose:"ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
	gpuVendor:"Google Inc. (Intel)",
	glVendor:"Mozilla",
	glRenderer:"Mozilla",

	// Current UA settings (kept consistent with each other)
	useragent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0",
	oscpu:"Windows NT 10.0; Win64; x64",
	platform:"Win32",
	vendor:"",
	uaFamily:"firefox",		// chromium | firefox | safari
	uaBrand:"Firefox",		// Google Chrome | Microsoft Edge | Firefox | Safari
	uaMajor:"158",
	uaPlatformName:"Windows"	// value for Sec-CH-UA-Platform / userAgentData.platform
};