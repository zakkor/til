import fs from 'fs'

// Options specified through the config file
type Config = {
	[index: string]: string
	compress: CompressKinds
}

const COMPRESS_KINDS = ['none', 'gzip', 'brotli'] as const
export type CompressKinds = (typeof COMPRESS_KINDS)[number] // Union type

// Read and validate config file
export function readConfig(path: string, prod: boolean): Config {
	// Defaults for `prod` == true
	const cfgDefault: Config = {
		compress: 'brotli',
	}

	let cfg: Config
	try {
		cfg = JSON.parse(fs.readFileSync(path, 'utf8'))
	} catch {
		console.log('no configuration file found, using defaults')
		cfg = cfgDefault
	}

	// If not specified or only some keys are specified, set defaults
	for (const [key] of Object.entries(cfg)) {
		if (cfg[key] === undefined) {
			cfg[key] = cfgDefault[key]
		}
	}

	// Validate config
	const invalidOption = (key: string, val: any) => {
		throw new Error(`invalid value "${val}" for config option "${key}"`)
	}

	if (!COMPRESS_KINDS.includes(cfg.compress)) {
		invalidOption('compress', cfg.compress)
	}

	// Set dev defaults
	if (prod === false) {
		// Never compress
		cfg.compress = 'none'
	}

	return cfg
}
