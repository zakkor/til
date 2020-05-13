import fs from 'fs'

// Options specified through the config file
export type Config = {
	verbose: boolean
	navigationSPA: boolean
	compress: CompressKinds
	uglify: boolean
	removeUnusedCSS: boolean
	images: ImagesConfig
	svgs: SVGsConfig
}

type ImagesConfig = {
	webp: boolean
	responsive: boolean
}

type SVGsConfig = {
	optimize: boolean
	inline: boolean
}

const COMPRESS_KINDS = ['none', 'gzip', 'brotli'] as const
export type CompressKinds = (typeof COMPRESS_KINDS)[number] // Union type

// Read and validate config file
export function readConfig(path: string, prod: boolean): Config {
	let cfgDefault: Config
	if (prod) {
		// Defaults for `prod` == true
		cfgDefault = {
			verbose: false,
			navigationSPA: true,
			compress: 'brotli',
			uglify: true,
			removeUnusedCSS: true,
			images: {
				webp: true,
				responsive: true,
			},
			svgs: {
				inline: true,
				optimize: true,
			}
		}
	} else {
		// Defaults for `prod` == false
		cfgDefault = {
			verbose: false,
			navigationSPA: true,
			compress: 'none',
			uglify: false,
			removeUnusedCSS: false,
			images: {
				webp: false,
				responsive: false,
			},
			svgs: {
				inline: false,
				optimize: false,
			}
		}
	}

	let cfg: Config
	try {
		cfg = JSON.parse(fs.readFileSync(path, 'utf8'))
	} catch {
		console.log('no configuration file found, using defaults')
		cfg = cfgDefault
	}

	// If some keys are not specified, set to default
	if (cfg.verbose === undefined) {
		cfg.verbose = cfgDefault.verbose
	}
	if (cfg.navigationSPA === undefined) {
		cfg.navigationSPA = cfgDefault.navigationSPA
	}
	if (cfg.compress === undefined) {
		cfg.compress = cfgDefault.compress
	}
	if (cfg.uglify === undefined) {
		cfg.uglify = cfgDefault.uglify
	}
	if (cfg.removeUnusedCSS === undefined) {
		cfg.removeUnusedCSS = cfgDefault.removeUnusedCSS
	}
	if (cfg.images === undefined) {
		cfg.images = cfgDefault.images
	}
	if (cfg.svgs === undefined) {
		cfg.svgs = cfgDefault.svgs
	}

	// Validate config
	const invalidOption = (key: string, val: any) => {
		throw new Error(`invalid value "${val}" for config option "${key}"`)
	}

	if (!COMPRESS_KINDS.includes(cfg.compress)) {
		invalidOption('compress', cfg.compress)
	}

	if (cfg.verbose) {
		console.log('\nconfig:', cfg)
	}

	return cfg
}
