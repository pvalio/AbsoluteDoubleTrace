/*
 * 	Trace error reporter script
 * 	Copyright AbsoluteDouble 2018 - 2020
 * 	Written by Jake Mcneill
 * 	https://absolutedouble.co.uk/
 */

"use strict";

window.onerror = function(o,r,e,c,l) {
	let n = {
		Title:(typeof document === "undefined" || !document.title ? "" : document.title),
		Msg:o,
		Url:r,
		Line:e,
		Column:c,
		Stack:l,
		StMsg:(l && l.message ? l.message : ""),
		Stck:(l && l.stack ? l.stack : "")
	};
	_UserCrashReportService(n);
};

// A general fix for browser that use window.browser instead of window.chrome
if (typeof window.chrome === "undefined" || !window.chrome.hasOwnProperty("extension")) window.chrome = (function (){ return window.msBrowser || window.browser || window.chrome; })();

/*
 * Error reporting (modified): reports are no longer sent anywhere.
 * The original sent page titles, stack traces, the real user-agent and a
 * persistent user ID to absolutedouble.co.uk, and ignored the user's
 * "Error Reporting" setting (consent was only checked when called with
 * o === false, which no caller ever did). The project is abandoned, so
 * errors are now only logged to this extension's own console.
 */
let _UserCrashReportService = function(d,o){
	try {
		console.warn("[Trace] Error (logged locally only):", d);
	} catch(e){}
	return false;
};
