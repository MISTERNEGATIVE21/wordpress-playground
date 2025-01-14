/// <reference lib="WebWorker" />
/**
 * Playground's service worker. Here's a rundown of non-obvious things that
 * are happening in here:
 *
 * ## Playground must be upgraded as early as possible after a new release
 *
 * New service workers call .skipWaiting(), immediately claim all the clients
 * that were controlled by the previous service worker, and forcibly refreshes
 * them.
 *
 * Why?
 *
 * Because Playground fetches new resources asynchronously and on demand. However,
 * deploying a new webapp version of the app destroys the resources referenced in
 * the previous webapp version. Therefore, we can't allow the previous version
 * to run when a new version becomes available.
 *
 * ### Push notifications
 *
 * It would be supremely useful to proactively notify the webapp after a fresh deployment.
 * Playground doesn't do that yet but it likely will in the future.
 *
 * ## Caching strategy
 *
 * Playground relies on the **Cache only** strategy. It loads assets from
 * the network, caches them, and serves them from the cache. The assumption
 * is that all network requests yield the most recent version of the remote file.
 *
 * This helps us avoid the HTTP cache problem.
 *
 * ### Cache layers
 *
 * We're dealing with the following cache layers:
 *
 * * HTTP cache in the browser
 * * CacheStorage in the service worker
 * * Edge Cache on playground.wordpress.net
 *
 * ### HTTP cache in the browser
 *
 * This service worker skips the browser HTTP cache for all network requests. This is because
 * the HTTP cache caused a particularly nasty problem in Playground deployments.
 *
 * Installing a new service worker purged the CacheStorage and requested a new set of assets
 * from the network. However, some of these requests were served from the HTTP cache. As a
 * result, Playground would start loading a mix of old and new assets and quickly error out.
 * What made it worse is that this broken state was cached in CacheStorage, breaking Playground
 * for weeks until the cache was refreshed.
 *
 * See https://github.com/WordPress/wordpress-playground/pull/1822 for more details.
 *
 * ### CacheStorage in the service worker
 *
 * This servive worker uses a **Cache only** strategy to ensure all the loaded assets
 * come from the same webapp build.
 *
 * The **Cache only** strategy means Playground only loads each assets from
 * the network once, caches it, and serves it from the cache from that point on.
 *
 * The only times Playground reaches to the network are:
 *
 * * Before the service worker is installed.
 * * When the service worker is being activated.
 * * On CacheStorage cache miss occurs.
 *
 * ### Edge Cache on playground.wordpress.net
 *
 * The remote server (playground.wordpress.net) has an Edge Cache that's populated with
 * all static assets on every webapp deployment. All the assets served by playground.wordpress.net
 * at any point in time come from the same build and are consistent with each other. The
 * deployment process is atomic-ish so the server should never expose a mix of old and new
 * assets.
 *
 * However, what if a new webapp version is deployed right when someone downloaded 10 out of
 * 27 static assets required to boot Playground?
 *
 * Right now, they'd end up in an undefined state and likely see an error. Then, on a page refresh,
 * they'd pick up a new service worker that would purge the stale assets and boot the new webapp
 * version.
 *
 * This is not a big problem for now, but it's also not the best user experience. This can be
 * eventually solved with push notifications. A new deployment would notify all the active
 * clients to upgrade and pick up the new assets.
 *
 * ## Related resources
 *
 * * PR that turned off HTTP caching: https://github.com/WordPress/wordpress-playground/pull/1822
 * * Exploring all the cache layers: https://github.com/WordPress/wordpress-playground/issues/1774
 * * Cache only strategy: https://web.dev/articles/offline-cookbook#cache-only
 * * Service worker caching and HTTP caching: https://web.dev/articles/service-worker-caching-and-http-caching
 */

declare const self: ServiceWorkerGlobalScope;

import { getURLScope, isURLScoped, removeURLScope } from '@php-wasm/scopes';
import { applyRewriteRules } from '@php-wasm/universal';
import {
	awaitReply,
	convertFetchEventToPHPRequest,
	cloneRequest,
	broadcastMessageExpectReply,
} from '@php-wasm/web-service-worker';
import { wordPressRewriteRules } from '@wp-playground/wordpress';
import { reportServiceWorkerMetrics } from '@php-wasm/logger';
import {
	cachedFetch,
	cacheOfflineModeAssetsForCurrentRelease,
	isCurrentServiceWorkerActive,
	purgeEverythingFromPreviousRelease,
	shouldCacheUrl,
} from './src/lib/offline-mode-cache';

if (!(self as any).document) {
	// Workaround: vite translates import.meta.url
	// to document.currentScript which fails inside of
	// a service worker because document is undefined
	// @ts-ignore
	// eslint-disable-next-line no-global-assign
	self.document = {};
}

/**
 * Forces the browser to always use the latest service worker.
 *
 * Each service worker build contains a hardcoded `buildVersion` used to derive a cache key
 * for offline-mode-cache. As long as the previous service worker is used, it will
 * keep serving a stale version of Playground assets, e.g. `/index.html`, `php.wasm`, etc.
 *
 * This is problematic for two reasons:
 *
 * 1. Users won't receive critical bugfixes for up to 24 hours after they're released [1].
 * 2. Users will experience fatal crashes. Assets such as the WebAssembly PHP builds are
 *    loaded asynchronously using fetch() and import() functions. The specific URLs are
 *    hardcoded by the bundler at build time, e.g. the worker-thread.js file contains
 *    a call similar to `import("./assets/php_8_3-2286e20c.js")`. If the browser uses
 *    a stale version of the worker thread, it will try to import a JavaScript file
 *    that no longer exists.
 *
 * See also: https://github.com/WordPress/wordpress-playground/issues/105
 *
 * [1] https://web.dev/articles/service-worker-lifecycle#updates
 */
self.addEventListener('install', (event) => {
	event.waitUntil(self.skipWaiting());
});

/**
 * Ensures:
 *
 * * The very first Playground load is controlled by this service worker.
 * * Other browser tabs are upgraded to the latest service worker.
 *
 * ## Initial load
 *
 * This is necessary because service workers don't control any pages loaded
 * before they are activated. This includes the page that actually registers
 * the service worker. You need to reload it before
 * `navigator.serviceWorker.controller` is set and the fetch() requests are
 * intercepted here.
 *
 * However, the initial Playground load already downloads a few large assets,
 * like a 12MB wordpress-static.zip file. We need to cache them these requests.
 * Otherwise they'll be fetched again on the next page load.
 *
 * client.claim() only affects pages loaded before the initial servie worker
 * registration. It shouldn't have unwanted side effects in our case. All these
 * pages would get controlled eventually anyway.
 *
 * ## Upgrading other browser tabs
 *
 * This activation hook upgrades all the Playground browser tabs to the latest
 * service worker version, and that service worker upgrades them the latest version
 * of the webapp.
 *
 * The moment a new Playground version is deployed, the existing browser tabs
 * won't be able to load assets from the network. The older Playground version
 * they're running contains hardcoded URLs to assets that no longer exist on
 * the server.
 *
 * See:
 * * The service worker lifecycle https://web.dev/articles/service-worker-lifecycle
 * * Clients.claim() docs https://developer.mozilla.org/en-US/docs/Web/API/Clients/claim
 */
self.addEventListener('activate', function (event) {
	async function doActivate() {
		await self.clients.claim();

		if (shouldCacheUrl(new URL(location.href))) {
			await purgeEverythingFromPreviousRelease();
			cacheOfflineModeAssetsForCurrentRelease();
		}

		// Reload all clients that were controlled by the previous service worker
		// so they can load the new version of the app without any stale assets
		// whatsoever.
		const windowClients = await self.clients.matchAll({
			type: 'window',
			includeUncontrolled: true,
		});

		for (const client of windowClients) {
			let url;
			try {
				url = new URL(client.url);
			} catch (e) {
				// Ignore
				return;
			}

			if (
				url.pathname.startsWith('/remote.html') ||
				url.pathname.startsWith('/scope:')
			) {
				return;
			}

			// @TODO: Store temporary sites in OPFS to avoid destroying in-memory
			// changes in tabs that are already open.
			client.navigate(client.url);
		}
	}
	event.waitUntil(doActivate());
});

self.addEventListener('fetch', (event) => {
	if (!isCurrentServiceWorkerActive()) {
		return;
	}

	const url = new URL(event.request.url);

	// Don't handle requests to the service worker script itself.
	if (url.pathname.startsWith(self.location.pathname)) {
		return;
	}

	const isReservedUrl =
		url.pathname.startsWith('/plugin-proxy') ||
		url.pathname.startsWith('/client/index.js');
	if (isReservedUrl) {
		return;
	}

	if (isURLScoped(url)) {
		return event.respondWith(handleScopedRequest(event, getURLScope(url)!));
	}

	let referrerUrl;
	try {
		referrerUrl = new URL(event.request.referrer);
	} catch (e) {
		// ignore
	}

	if (referrerUrl && isURLScoped(referrerUrl)) {
		return event.respondWith(
			handleScopedRequest(event, getURLScope(referrerUrl)!)
		);
	}

	if (!shouldCacheUrl(new URL(event.request.url))) {
		/**
		 * It's safe to use the regular `fetch` function here.
		 *
		 * This request won't be cached in the offline mode cache
		 * and there's no risk of the two caches interfering with
		 * each other.
		 *
		 * See service-worker.ts for more details.
		 */
		return;
	}

	// Use Cache Only strategy to serve regular static assets.
	return event.respondWith(cachedFetch(event.request));
});

/**
 * A request to a PHP Worker Thread or to a regular static asset,
 * but initiated by a scoped referer (e.g. fetch() from a block editor iframe).
 */
async function handleScopedRequest(event: FetchEvent, scope: string) {
	const fullUrl = new URL(event.request.url);
	const unscopedUrl = removeURLScope(fullUrl);
	if (fullUrl.pathname.endsWith('/wp-includes/empty.html')) {
		return emptyHtml();
	}

	const workerResponse = await convertFetchEventToPHPRequest(event);

	if (
		workerResponse.status === 404 &&
		workerResponse.headers.get('x-backfill-from') === 'remote-host'
	) {
		const { staticAssetsDirectory } = await getScopedWpDetails(scope!);
		if (!staticAssetsDirectory) {
			const plain404Response = workerResponse.clone();
			plain404Response.headers.delete('x-backfill-from');
			return plain404Response;
		}

		// If we get a 404 for a static file, try to fetch it from
		// the from the static assets directory at the remote server.
		const requestedUrl = new URL(event.request.url);
		const resolvedUrl = removeURLScope(requestedUrl);
		resolvedUrl.pathname = applyRewriteRules(
			resolvedUrl.pathname,
			wordPressRewriteRules
		);
		if (
			// Vite dev server requests
			!resolvedUrl.pathname.startsWith('/@fs') &&
			!resolvedUrl.pathname.startsWith('/assets')
		) {
			resolvedUrl.pathname = `/${staticAssetsDirectory}${resolvedUrl.pathname}`;
		}
		const request = await cloneRequest(event.request, {
			url: resolvedUrl,
			// Omit credentials to avoid causing cache aborts due to presence of
			// cookies
			credentials: 'omit',
		});

		/**
		 * Intentionally use fetch() over fetchFresh().
		 *
		 * At this point we know this request very likely came from WordPress
		 * and is looking for a WordPress-related static asset. WordPress
		 * has its own caching strategies in place. We're going to pass this
		 * request to the remote server as it is and let WordPress manage its
		 * own HTTP caching.
		 */
		return fetch(request).catch((e) => {
			if (e?.name === 'TypeError') {
				// This could be an ERR_HTTP2_PROTOCOL_ERROR that sometimes
				// happen on playground.wordpress.net. Let's add a randomized
				// delay and retry once
				return new Promise((resolve) => {
					setTimeout(
						() => resolve(fetch(request)),
						Math.random() * 1500
					);
				}) as Promise<Response>;
			}

			// Otherwise let's just re-throw the error
			throw e;
		});
	}

	// Path the block-editor.js file to ensure the site editor's iframe
	// inherits the service worker.
	// @see controlledIframe below for more details.
	if (
		// WordPress Core version of block-editor.js
		unscopedUrl.pathname.endsWith('/wp-includes/js/dist/block-editor.js') ||
		unscopedUrl.pathname.endsWith(
			'/wp-includes/js/dist/block-editor.min.js'
		) ||
		// Gutenberg version of block-editor.js
		unscopedUrl.pathname.endsWith('/build/block-editor/index.js') ||
		unscopedUrl.pathname.endsWith('/build/block-editor/index.min.js')
	) {
		const script = await workerResponse.text();
		const newScript = `${controlledIframe} ${script.replace(
			/\(\s*"iframe",/,
			'(__playground_ControlledIframe,'
		)}`;
		return new Response(newScript, {
			status: workerResponse.status,
			statusText: workerResponse.statusText,
			headers: workerResponse.headers,
		});
	}

	return workerResponse;
}

reportServiceWorkerMetrics(self);

/**
 * Pair the site editor's nested iframe to the Service Worker.
 *
 * Without the patch below, the site editor initiates network requests that
 * aren't routed through the service worker. That's a known browser issue:
 *
 * * https://bugs.chromium.org/p/chromium/issues/detail?id=880768
 * * https://bugzilla.mozilla.org/show_bug.cgi?id=1293277
 * * https://github.com/w3c/ServiceWorker/issues/765
 *
 * The problem with iframes using srcDoc and src="about:blank" as they
 * fail to inherit the root site's service worker.
 *
 * Gutenberg loads the site editor using <iframe srcDoc="<!doctype html">
 * to force the standards mode and not the quirks mode:
 *
 * https://github.com/WordPress/gutenberg/pull/38855
 *
 * This commit patches the site editor to achieve the same result via
 * <iframe src="/doctype.html"> and a doctype.html file containing just
 * `<!doctype html>`. This allows the iframe to inherit the service worker
 * and correctly load all the css, js, fonts, images, and other assets.
 *
 * Ideally this issue would be fixed directly in Gutenberg and the patch
 * below would be removed.
 *
 * See https://github.com/WordPress/wordpress-playground/issues/42 for more details
 *
 * ## Why does this code live in the service worker?
 *
 * There's many ways to install the Gutenberg plugin:
 *
 * * Install plugin step
 * * Import a site
 * * Install Gutenberg from the plugin directory
 * * Upload a Gutenberg zip
 *
 * It's too difficult to patch Gutenberg in all these cases, so we
 * blanket-patch all the scripts requested over the network whose names seem to
 * indicate they're related to the Gutenberg plugin.
 */
const controlledIframe = `
window.__playground_ControlledIframe = window.wp.element.forwardRef(function (props, ref) {
	const source = window.wp.element.useMemo(function () {
		/**
		 * A synchronous function to read a blob URL as text.
		 *
		 * @param {string} url
		 * @returns {string}
		 */
		const __playground_readBlobAsText = function (url) {
			try {
			let xhr = new XMLHttpRequest();
			xhr.open('GET', url, false);
			xhr.overrideMimeType('text/plain;charset=utf-8');
			xhr.send();
			return xhr.responseText;
			} catch(e) {
			return '';
			} finally {
			URL.revokeObjectURL(url);
			}
		};
		if (props.srcDoc) {
			// WordPress <= 6.2 uses a srcDoc that only contains a doctype.
			return '/wp-includes/empty.html';
		} else if (props.src && props.src.startsWith('blob:')) {
			// WordPress 6.3 uses a blob URL with doctype and a list of static assets.
			// Let's pass the document content to empty.html and render it there.
			return '/wp-includes/empty.html#' + encodeURIComponent(__playground_readBlobAsText(props.src));
		} else {
			// WordPress >= 6.4 uses a plain HTTPS URL that needs no correction.
			return props.src;
		}
	}, [props.src]);
	return (
		window.wp.element.createElement('iframe', {
			...props,
			ref: ref,
			src: source,
			// Make sure there's no srcDoc, as it would interfere with the src.
			srcDoc: undefined
		})
	)
});`;

/**
 * The empty HTML file loaded by the patched editor iframe.
 */
function emptyHtml() {
	return new Response(
		'<!doctype html><script>const hash = window.location.hash.substring(1); if ( hash ) document.write(decodeURIComponent(hash))</script>',
		{
			status: 200,
			headers: {
				'content-type': 'text/html',
			},
		}
	);
}

type WPModuleDetails = {
	staticAssetsDirectory?: string;
};

const scopeToWpModule: Record<string, WPModuleDetails> = {};
async function getScopedWpDetails(scope: string): Promise<WPModuleDetails> {
	if (!scopeToWpModule[scope]) {
		const requestId = await broadcastMessageExpectReply(
			{
				method: 'getWordPressModuleDetails',
			},
			scope
		);
		scopeToWpModule[scope] = await awaitReply(self, requestId);
	}
	return scopeToWpModule[scope];
}
