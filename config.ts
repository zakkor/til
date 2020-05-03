import fs from 'fs'

// Options specified through the config file
export type Config = {
	compress: CompressKinds
	uglify: boolean
	removeUnusedCSS: boolean
	verbose: boolean
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
			compress: 'brotli',
			uglify: true,
			removeUnusedCSS: true,
		}
	} else {
		// Defaults for `prod` == false
		cfgDefault = {
			verbose: false,
			compress: 'none',
			uglify: false,
			removeUnusedCSS: false,
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
	if (cfg.compress === undefined) {
		cfg.compress = cfgDefault.compress
	}
	if (cfg.uglify === undefined) {
		cfg.uglify = cfgDefault.uglify
	}
	if (cfg.removeUnusedCSS === undefined) {
		cfg.removeUnusedCSS = cfgDefault.removeUnusedCSS
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
