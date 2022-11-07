#!/usr/bin/env node
let fs = require('fs'),
	connect = require('connect'),
	serveIndex = require('serve-index'),
	logger = require('morgan'),
	WebSocket = require('faye-websocket'),
	path = require('path'),
	url = require('url'),
	http = require('http'),
	send = require('send'),
	open = require('opn'),
	es = require("event-stream"),
	os = require('os'),
	chokidar = require('chokidar');
require('colors');

let INJECTED_CODE = fs.readFileSync(path.join(__dirname, "injected.html"), "utf8");

let LiveServer = {
	server: null,
	watcher: null,
	logLevel: 2
};

function escape(html){
	return String(html)
		.replace(/&(?!\w+;)/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Based on connect.static(), but streamlined and with added code injector
function staticServer(root) {
	let isFile = false;
	try { // For supporting mounting files instead of just directories
		isFile = fs.statSync(root).isFile();
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	return function(req, res, next) {
		if (req.method !== "GET" && req.method !== "HEAD") return next();
		let reqpath = isFile ? "" : url.parse(req.url).pathname;
		let hasNoOrigin = !req.headers.origin;
		let injectCandidates = [ new RegExp("</body>", "i"), new RegExp("</svg>"), new RegExp("</head>", "i")];
		let injectTag = null;

		function directory() {
			let pathname = url.parse(req.originalUrl).pathname;
			res.statusCode = 301;
			res.setHeader('Location', pathname + '/');
			res.end('Redirecting to ' + escape(pathname) + '/');
		}

		function file(filepath /*, stat*/) {
			let x = path.extname(filepath).toLocaleLowerCase(), match,
					possibleExtensions = [ "", ".html", ".htm", ".xhtml", ".php", ".svg" ];
			if (hasNoOrigin && (possibleExtensions.indexOf(x) > -1)) {
				// TODO: Sync file read here is not nice, but we need to determine if the html should be injected or not
				let contents = fs.readFileSync(filepath, "utf8");
				for (let i = 0; i < injectCandidates.length; ++i) {
					match = injectCandidates[i].exec(contents);
					if (match) {
						injectTag = match[0];
						break;
					}
				}
				if (injectTag === null && LiveServer.logLevel >= 3) {
					console.warn("Failed to inject refresh script!".yellow,
						"Couldn't find any of the tags ", injectCandidates, "from", filepath);
				}
			}
		}

		function error(err) {
			if (err.status === 404) return next();
			next(err);
		}

		function inject(stream) {
			if (injectTag) {
				// We need to modify the length given to browser
				let len = INJECTED_CODE.length + res.getHeader('Content-Length');
				res.setHeader('Content-Length', len);
				let originalPipe = stream.pipe;
				stream.pipe = function(resp) {
					originalPipe.call(stream, es.replace(new RegExp(injectTag, "i"), INJECTED_CODE + injectTag)).pipe(resp);
				};
			}
		}

		send(req, reqpath, { root: root })
			.on('error', error)
			.on('directory', directory)
			.on('file', file)
			.on('stream', inject)
			.pipe(res);
	};
}

/**
 * Rewrite request URL and pass it back to the static handler.
 * @param staticHandler {function} Next handler
 * @param file {string} Path to the entry point file
 */
function entryPoint(staticHandler, file) {
	if (!file) return function(req, res, next) { next(); };

	return function(req, res, next) {
		req.url = "/" + file;
		staticHandler(req, res, next);
	};
}

/**
 * Start a live server with parameters given as an object
 * @param host {string} Address to bind to (default: 0.0.0.0)
 * @param port {number} Port number (default: 8080)
 * @param root {string} Path to root directory (default: cwd)
 * @param watch {array} Paths to exclusively watch for changes
 * @param ignore {array} Paths to ignore when watching files for changes
 * @param ignorePattern {regexp} Ignore files by RegExp
 * @param noCssInject Don't inject CSS changes, just reload as with any other file change
 * @param open {(string|string[])} Subpath(s) to open in browser, use false to suppress launch (default: server root)
 * @param mount {array} Mount directories onto a route, e.g. [['/components', './node_modules']].
 * @param logLevel {number} 0 = errors only, 1 = some, 2 = lots
 * @param file {string} Path to the entry point file
 * @param wait {number} Server will wait for all changes, before reloading
 * @param htpasswd {string} Path to htpasswd file to enable HTTP Basic authentication
 * @param middleware {array} Append middleware to stack, e.g. [function(req, res, next) { next(); }].
 */
LiveServer.start = function(options) {
	options = options || {};
	let host = options.host || '0.0.0.0';
	let port = options.port !== undefined ? options.port : 8080; // 0 means random
	let root = options.root || process.cwd();
	let mount = options.mount || [];
	let watchPaths = options.watch || [root];
	LiveServer.logLevel = options.logLevel === undefined ? 2 : options.logLevel;
	let openPath = (options.open === undefined || options.open === true) ?
		"" : ((options.open === null || options.open === false) ? null : options.open);
	if (options.noBrowser) openPath = null; // Backwards compatibility with 0.7.0
	let file = options.file;
	let staticServerHandler = staticServer(root);
	let wait = options.wait === undefined ? 100 : options.wait;
	let browser = options.browser || null;
	let htpasswd = options.htpasswd || null;
	let cors = options.cors || false;
	let https = options.https || null;
	let proxy = options.proxy || [];
	let middleware = options.middleware || [];
	let noCssInject = options.noCssInject;
	let httpsModule = options.httpsModule;

	if (httpsModule) {
		try {
			require.resolve(httpsModule);
		} catch (e) {
			console.error(("HTTPS module \"" + httpsModule + "\" you've provided was not found.").red);
			console.error("Did you do", "\"npm install " + httpsModule + "\"?");
			return;
		}
	} else {
		httpsModule = "https";
	}

	// Setup a web server
	let app = connect();

	// Add logger. Level 2 logs only errors
	if (LiveServer.logLevel === 2) {
		app.use(logger('dev', {
			skip: function (req, res) { return res.statusCode < 400; }
		}));
	// Level 2 or above logs all requests
	} else if (LiveServer.logLevel > 2) {
		app.use(logger('dev'));
	}
	if (options.spa) {
		middleware.push("spa");
	}
	// Add middleware
	middleware.map(function(mw) {
		if (typeof mw === "string") {
			let ext = path.extname(mw).toLocaleLowerCase();
			if (ext !== ".js") {
				mw = require(path.join(__dirname, "middleware", mw + ".js"));
			} else {
				mw = require(mw);
			}
		}
		app.use(mw);
	});

	// Use http-auth if configured
	if (htpasswd !== null) {
		let auth = require('http-auth');
		let basic = auth.basic({
			realm: "Please authorize",
			file: htpasswd
		});
		app.use(auth.connect(basic));
	}
	if (cors) {
		app.use(require("cors")({
			origin: true, // reflecting request origin
			credentials: true // allowing requests with credentials
		}));
	}
	mount.forEach(function(mountRule) {
		let mountPath = path.resolve(process.cwd(), mountRule[1]);
		if (!options.watch) // Auto add mount paths to watch but only if exclusive path option is not given
			watchPaths.push(mountPath);
		app.use(mountRule[0], staticServer(mountPath));
		if (LiveServer.logLevel >= 1)
			console.log('Mapping %s to "%s"', mountRule[0], mountPath);
	});
	proxy.forEach(function(proxyRule) {
		let proxyOpts = url.parse(proxyRule[1]);
		proxyOpts.via = true;
		proxyOpts.preserveHost = true;
		app.use(proxyRule[0], require('proxy-middleware')(proxyOpts));
		if (LiveServer.logLevel >= 1)
			console.log('Mapping %s to "%s"', proxyRule[0], proxyRule[1]);
	});
	app.use(staticServerHandler) // Custom static server
		.use(entryPoint(staticServerHandler, file))
		.use(serveIndex(root, { icons: true }));

	let server, protocol;
	if (https !== null) {
		let httpsConfig = https;
		if (typeof https === "string") {
			httpsConfig = require(path.resolve(process.cwd(), https));
		}
		server = require(httpsModule).createServer(httpsConfig, app);
		protocol = "https";
	} else {
		server = http.createServer(app);
		protocol = "http";
	}

	// Handle server startup errors
	server.addListener('error', function(e) {
		if (e.code === 'EADDRINUSE') {
			let serveURL = protocol + '://' + host + ':' + port;
			console.log('%s is already in use. Trying another port.'.yellow, serveURL);
			setTimeout(function() {
				server.listen(0, host);
			}, 1000);
		} else {
			console.error(e.toString().red);
			LiveServer.shutdown();
		}
	});

	// Handle successful server
	server.addListener('listening', function(/*e*/) {
		LiveServer.server = server;

		let address = server.address();
		let serveHost = address.address === "0.0.0.0" ? "127.0.0.1" : address.address;
		let openHost = host === "0.0.0.0" ? "127.0.0.1" : host;

		let serveURL = protocol + '://' + serveHost + ':' + address.port;
		let openURL = protocol + '://' + openHost + ':' + address.port;

		let serveURLs = [ serveURL ];
		if (LiveServer.logLevel > 2 && address.address === "0.0.0.0") {
			let ifaces = os.networkInterfaces();
			serveURLs = Object.keys(ifaces)
				.map(function(iface) {
					return ifaces[iface];
				})
				// flatten address data, use only IPv4
				.reduce(function(data, addresses) {
					addresses.filter(function(addr) {
						return addr.family === "IPv4";
					}).forEach(function(addr) {
						data.push(addr);
					});
					return data;
				}, [])
				.map(function(addr) {
					return protocol + "://" + addr.address + ":" + address.port;
				});
		}

		// Output
		if (LiveServer.logLevel >= 1) {
			if (serveURL === openURL)
				if (serveURLs.length === 1) {
					console.log(("Serving \"%s\" at %s").green, root, serveURLs[0]);
				} else {
					console.log(("Serving \"%s\" at\n\t%s").green, root, serveURLs.join("\n\t"));
				}
			else
				console.log(("Serving \"%s\" at %s (%s)").green, root, openURL, serveURL);
		}

		// Launch browser
		if (openPath !== null)
			if (typeof openPath === "object") {
				openPath.forEach(function(p) {
					open(openURL + p, {app: browser});
				});
			} else {
				open(openURL + openPath, {app: browser});
			}
	});

	// Setup server to listen at port
	server.listen(port, host);

	// WebSocket
	let clients = [];
	server.addListener('upgrade', function(request, socket, head) {
		let ws = new WebSocket(request, socket, head);
		ws.onopen = function() { ws.send('connected'); };

		if (wait > 0) {
			(function() {
				let wssend = ws.send;
				let waitTimeout;
				ws.send = function() {
					let args = arguments;
					if (waitTimeout) clearTimeout(waitTimeout);
					waitTimeout = setTimeout(function(){
						wssend.apply(ws, args);
					}, wait);
				};
			})();
		}

		ws.onclose = function() {
			clients = clients.filter(function (x) {
				return x !== ws;
			});
		};

		clients.push(ws);
	});

	let ignored = [
		function(testPath) { // Always ignore dotfiles (important e.g. because editor hidden temp files)
			return testPath !== "." && /(^[.#]|(?:__|~)$)/.test(path.basename(testPath));
		}
	];
	if (options.ignore) {
		ignored = ignored.concat(options.ignore);
	}
	if (options.ignorePattern) {
		ignored.push(options.ignorePattern);
	}
	// Setup file watcher
	LiveServer.watcher = chokidar.watch(watchPaths, {
		ignored: ignored,
		ignoreInitial: true
	});
	function handleChange(changePath) {
		let cssChange = path.extname(changePath) === ".css" && !noCssInject;
		if (LiveServer.logLevel >= 1) {
			if (cssChange)
				console.log("CSS change detected".magenta, changePath);
			else console.log("Change detected".cyan, changePath);
		}
		clients.forEach(function(ws) {
			if (ws)
				ws.send(cssChange ? 'refreshcss' : 'reload');
		});
	}
	LiveServer.watcher
		.on("change", handleChange)
		.on("add", handleChange)
		.on("unlink", handleChange)
		.on("addDir", handleChange)
		.on("unlinkDir", handleChange)
		.on("ready", function () {
			if (LiveServer.logLevel >= 1)
				console.log("Ready for changes".cyan);
		})
		.on("error", function (err) {
			console.log("ERROR:".red, err);
		});

	return server;
};

LiveServer.shutdown = function() {
	let watcher = LiveServer.watcher;
	if (watcher) {
		watcher.close();
	}
	let server = LiveServer.server;
	if (server)
		server.close();
};

module.exports = LiveServer;
