import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const VALID_RUNTIMES = ['edge', 'nodejs16.x', 'nodejs18.x'];

const get_default_runtime = () => {
	const major = process.version.slice(1).split('.')[0];
	if (major === '16') return 'nodejs16.x';
	if (major === '18') return 'nodejs18.x';

	throw new Error(
		`Unsupported Node.js version: ${process.version}. Please use Node 16 or Node 18 to build your project, or explicitly specify a runtime in your adapter configuration.`
	);
};

/** @type {import('.').default} **/
const plugin = function (defaults = {}) {
	if ('edge' in defaults) {
		throw new Error("{ edge: true } has been removed in favour of { runtime: 'edge' }");
	}

	return {
		name: '@sveltejs/adapter-open-runtimes',

		async adapt(builder) {
			if (!builder.routes) {
				throw new Error(
					'@sveltejs/adapter-open-runtimes >=2.x (possibly installed through @sveltejs/adapter-auto) requires @sveltejs/kit version 1.5 or higher. ' +
						'Either downgrade the adapter or upgrade @sveltejs/kit'
				);
			}

			const dir = '.open-runtimes';
			const tmp = builder.getBuildDirectory('open-runtimes-tmp');

			builder.rimraf(dir);
			builder.rimraf(tmp);

			const files = fileURLToPath(new URL('./files', import.meta.url).href);

			const dirs = {
				static: `${dir}/static${builder.config.kit.paths.base}`,
				function: `${dir}`
			};

			const static_config = static_vercel_config(builder);

			builder.log.minor('Generating serverless function...');

			/**
			 * @param {string} name
			 * @param {import('.').EdgeConfig} config
			 * @param {import('@sveltejs/kit').RouteDefinition<import('.').EdgeConfig>[]} routes
			 */
			async function generate_edge_function(name, config, routes) {
				const tmp = builder.getBuildDirectory(`open-runtimes-tmp/${name}`);
				const relativePath = path.posix.relative(tmp, builder.getServerDirectory());

				const envVarsInUse = new Set();
				routes.forEach((route) => {
					route.config?.envVarsInUse?.forEach((x) => {
						envVarsInUse.add(x);
					});
				});

				builder.copy(`${files}/edge.js`, `${tmp}/edge.js`, {
					replace: {
						SERVER: `${relativePath}/index.js`,
						MANIFEST: './manifest.js'
					}
				});

				write(
					`${tmp}/manifest.js`,
					`export const manifest = ${builder.generateManifest({ relativePath, routes })};\n`
				);

				await esbuild.build({
					entryPoints: [`${tmp}/edge.js`],
					outfile: `${dirs.function}/index.js`,
					target: 'es2020', // TODO verify what the edge runtime supports
					bundle: true,
					platform: 'browser',
					format: 'esm',
					external: config.external,
					sourcemap: 'linked',
					banner: { js: 'global.fs = require("fs");\nglobal.path = require("path");\nglobal.crypto = require("crypto");\nglobalThis.global = globalThis;' }
				});
			}

			/** @type {Map<string, { i: number, config: import('.').Config, routes: import('@sveltejs/kit').RouteDefinition<import('.').Config>[] }>} */
			const groups = new Map();

			/** @type {Map<string, { hash: string, route_id: string }>} */
			const conflicts = new Map();

			/** @type {Map<string, string>} */
			const functions = new Map();

			// group routes by config
			for (const route of builder.routes) {
				if (route.prerender === true) continue;

				const pattern = route.pattern.toString();

				const runtime = route.config?.runtime ?? defaults?.runtime ?? get_default_runtime();
				if (runtime && !VALID_RUNTIMES.includes(runtime)) {
					throw new Error(
						`Invalid runtime '${runtime}' for route ${
							route.id
						}. Valid runtimes are ${VALID_RUNTIMES.join(', ')}`
					);
				}

				const config = { runtime, ...defaults, ...route.config };

				const hash = hash_config(config);

				// first, check there are no routes with incompatible configs that will be merged
				const existing = conflicts.get(pattern);
				if (existing) {
					if (existing.hash !== hash) {
						throw new Error(
							`The ${route.id} and ${existing.route_id} routes must be merged into a single function that matches the ${route.pattern} regex, but they have incompatible configs. You must either rename one of the routes, or make their configs match.`
						);
					}
				} else {
					conflicts.set(pattern, { hash, route_id: route.id });
				}

				// then, create a group for each config
				const id = hash;
				let group = groups.get(id);
				if (!group) {
					group = { i: groups.size, config, routes: [] };
					groups.set(id, group);
				}

				group.routes.push(route);
			}

			for (const group of groups.values()) {
				const generate_function = generate_edge_function;

				// generate one function for the group
				const name = `fn-${group.i}`;
				await generate_function(
					name,
					/** @type {any} */ (group.config),
					/** @type {import('@sveltejs/kit').RouteDefinition<any>[]} */ (group.routes)
				);

				if (groups.size === 1) {
					// Special case: One function for all routes
					static_config.routes.push({ src: '/.*', dest: `/${name}` });
				} else {
					for (const route of group.routes) {
						functions.set(route.pattern.toString(), name);
					}
				}
			}

			for (const route of builder.routes) {
				if (route.prerender === true) continue;

				const pattern = route.pattern.toString();

				let src = pattern
					// remove leading / and trailing $/
					.slice(1, -2)
					// replace escaped \/ with /
					.replace(/\\\//g, '/');

				// replace the root route "^/" with "^/?"
				if (src === '^/') {
					src = '^/?';
				}

				src += '(?:/__data.json)?$';

				const name = functions.get(pattern);
				if (name) {
					static_config.routes.push({ src, dest: `/${name}` });
					functions.delete(pattern);
				}
			}

			builder.log.minor('Copying assets...');

			builder.writeClient(dirs.static);
			builder.writePrerendered(dirs.static);

			builder.log.minor('Writing routes...');

			write(`${dir}/config.json`, JSON.stringify(static_config, null, '\t'));
		}
	};
};

/** @param {import('.').EdgeConfig & import('.').ServerlessConfig} config */
function hash_config(config) {
	return [
		config.runtime ?? '',
		config.external ?? '',
		config.regions ?? '',
		config.memory ?? '',
		config.maxDuration ?? '',
		config.isr?.expiration ?? '',
		config.isr?.group ?? '',
		config.isr?.bypassToken ?? '',
		config.isr?.allowQuery ?? ''
	].join('/');
}

/**
 * @param {string} file
 * @param {string} data
 */
function write(file, data) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
	} catch {
		// do nothing
	}

	fs.writeFileSync(file, data);
}

// This function is duplicated in adapter-static
/** @param {import('@sveltejs/kit').Builder} builder */
function static_vercel_config(builder) {
	/** @type {any[]} */
	const prerendered_redirects = [];

	/** @type {Record<string, { path: string }>} */
	const overrides = {};

	for (const [src, redirect] of builder.prerendered.redirects) {
		prerendered_redirects.push({
			src,
			headers: {
				Location: redirect.location
			},
			status: redirect.status
		});
	}

	for (const [path, page] of builder.prerendered.pages) {
		let overrides_path = path.slice(1);

		if (path !== '/') {
			/** @type {string | undefined} */
			let counterpart_route = path + '/';

			if (path.endsWith('/')) {
				counterpart_route = path.slice(0, -1);
				overrides_path = path.slice(1, -1);
			}

			prerendered_redirects.push(
				{ src: path, dest: counterpart_route },
				{ src: counterpart_route, status: 308, headers: { Location: path } }
			);
		}

		overrides[page.file] = { path: overrides_path };
	}

	return {
		version: 3,
		routes: [
			...prerendered_redirects,
			{
				src: `/${builder.getAppPath()}/immutable/.+`,
				headers: {
					'cache-control': 'public, immutable, max-age=31536000'
				}
			},
			{
				handle: 'filesystem'
			}
		],
		overrides
	};
}

export default plugin;
