import fs from 'fs'
import filepath from 'path'
import htmlMinifier from 'html-minifier'
import uglifyJS from 'uglify-js'
import zlib from 'zlib'
import { rip } from './styleripper'

const ComponentRegex = /<%(.+)%>/g

const NavigationTemplate = `var r = {}
var req = new XMLHttpRequest();
req.addEventListener('load', function(){
	var nr = JSON.parse(this.responseText)
	for (var key in nr) {
		r[key] = nr[key]
	}
})
req.open('GET', "/_til/nav"+location.pathname+'routes.json')
req.send()
var html = document.querySelector('html')
function d() {
	document.querySelectorAll('a[href]').forEach(function(e) { e.onclick = g })
}
function g(e) {
	var t = e.target.closest('a[href]')
	var p = typeof e == 'object' ? t.getAttribute('href') : e
	if (!(p in r)) {
		console.error('route does not exist:', p)
		return false
	}
	html.innerHTML = r[p]
	history.pushState({}, '', p)
	d()
	return false
}
window.onpopstate = function() {
	g(location.pathname)
}
d()
r[location.pathname] = html.innerHTML`

export type File = {
	path: string
	data: string
}

// Options specified through env vars or as command-line arguments
type Options = {
	configPath: string
	prod: boolean
}

// Options specified through the config file
type Config = {
	compress: CompressKinds
}

const COMPRESS_KINDS = ['none', 'gzip', 'brotli'] as const
type CompressKinds = (typeof COMPRESS_KINDS)[number] // Union type

type WalkFn = (path: string, isDir: boolean) => void
type WatchFn = (path: string) => void

function processComponents(pages: File[]): void {
	pages.forEach(page => {
		// Match each component name, specified like "<%component%>"
		let m: RegExpExecArray | null
		while (m = ComponentRegex.exec(page.data)) {
			const compTempl = m[0]
			const re = new RegExp(compTempl, 'g')
			const comp = m[1]
			const compData = fs.readFileSync(`./components/${comp}/index.html`, 'utf8')

			page.data = page.data.replace(re, compData)
		}
	})
}

function build({ prod, configPath }: Options) {
	const cfg = readConfig(configPath, prod)

	let pages = collectFiles(['./pages'], ['.html'])
	let styles = collectFiles(['./pages', './styles'], ['.css'])
	let scripts = collectFiles(['./pages'], ['.js'])

	// Go through each page and instantiate components
	processComponents(pages)

	// Use Styleripper to process HTML and CSS
	// CSS is inlined within each HTML file by default
	// If minify is true, node names will be minified
	pages = rip(pages, styles, {
		// Minify in production
		minify: prod,
	})

	let routes: { [index: string]: string } = {}
	for (const page of pages) {
		let data = page.data
		if (prod) {
			data = minifyHTML(page.data)
		}
		routes[pathToRoute(page.path)] = data
	}

	fs.mkdirSync('./dist', { recursive: true })
	// Remove each item in "dist" dir
	walkToplevel('./dist', (path, isDir) => {
		if (isDir) {
			fs.rmdirSync(path, { recursive: true })
			return
		}
		fs.unlinkSync(path)
	})

	// Create all output directories
	walk('./pages', [], (path, isDir) => {
		if (isDir) {
			fs.mkdirSync(`./dist/${removeFirstDir(path)}`, { recursive: true })
		}
	})

	// TODO: move to processNavigation
	let navigation = NavigationTemplate
	if (prod) {
		navigation = uglifyJS.minify(navigation).code
	}

	for (const page of pages) {
		// Delete this page from routes, we can add the page HTML to the routes after the page loads
		let pageRoutes = Object.assign({}, routes)
		delete (pageRoutes[pathToRoute(page.path)])
		const routesJSON = JSON.stringify(pageRoutes)

		fs.mkdirSync(`./dist/_til/nav/${pathToRoute(page.path)}`, { recursive: true })
		writeFile(`./dist/_til/nav/${pathToRoute(page.path)}/routes.json`, routesJSON, cfg.compress)

		page.data = page.data.replace('</body>', `</body><script>${navigation}</script>`)
		if (prod) {
			page.data = minifyHTML(page.data)
		}

		// Write HTML to file
		writeFile(`./dist/${removeFirstDir(page.path)}`, page.data, cfg.compress)
	}

	// Uglify JS, concat to bundle.js, and write to file.
	if (prod) {
		for (const f of scripts) {
			f.data = uglifyJS.minify(f.data).code
		}
	}
	const jsBundle = concatFiles(scripts)
	if (jsBundle !== '') {
		writeFile('./dist/bundle.js', jsBundle, cfg.compress)
	}

	// // Write static files
	// fs.mkdirSync('./dist/static', { recursive: true })
	// for (const img of images) {
	// 	fs.writeFileSync(`./dist/${img.path}`, img.data)
	// }
}

// Read and validate config file
function readConfig(path: string, prod: boolean): Config {
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
	// Validate config
	const invalidKeyVal = (key: string, val: CompressKinds) => {
		throw new Error(`configuration file invalid: unrecognized value ${val} for key "${key}"`)
	}
	if (cfg.compress === undefined) {
		cfg.compress = cfgDefault.compress
	}
	if (!COMPRESS_KINDS.includes(cfg.compress)) {
		invalidKeyVal('compress', cfg.compress)
	}

	// Set dev defaults
	if (!prod) {
		// Never compress
		cfg.compress = 'none'
	}

	return cfg
}

function watch(fn: WatchFn) {
	const watcher = (file: string) => {
		let wtimeout: NodeJS.Timeout | null
		// Debounce
		return () => {
			if (wtimeout == null) {
				// If we don't wait a bit before running the function, some files may not be fully written
				setTimeout(() => {
					fn(file)
				}, 100)
				wtimeout = setTimeout(() => { wtimeout = null }, 200)
			}
		}
	}

	const paths = collect(['./'], ['.html', '.css', '.js'], ['node_modules', 'dist'])
	for (const p of paths) {
		fs.watch(p, {}, watcher(p))
	}
}

export default {
	build,
	watch,
}

// Call function on every file
function walk(path: string, exclude: string[], fn: WalkFn): void {
	const dir = fs.opendirSync(path)

	let dirent: fs.Dirent
	while (dirent = dir.readSync()) {
		if (dirent === null) {
			break
		}

		const full = filepath.join(path, dirent.name)
		if (dirent.isDirectory()) {
			let ok = true
			for (const excl of exclude) {
				if (full.endsWith(excl)) {
					ok = false
					break
				}
			}
			if (!ok) {
				continue
			}

			walk(full, exclude, fn)
			fn(full, true) // is dir
		} else {
			fn(full, false) // is not dir
		}
	}
	dir.closeSync()
}


function walkToplevel(path: string, fn: WalkFn): void {
	const dir = fs.opendirSync(path)
	let dirent = null
	while (dirent = dir.readSync()) {
		if (dirent === null) {
			break
		}

		const full = filepath.join(path, dirent.name)
		fn(full, dirent.isDirectory())
	}
	dir.closeSync()
}

function collectFiles(paths: string[], extensions: string[]): File[] {
	return collect(paths, extensions).map(f => { return { path: f, data: fs.readFileSync(f, 'utf8') } })
}

function collect(paths: string[], extensions: string[], exclude: string[] = []): string[] {
	let files: string[] = []
	for (const path of paths) {
		walk(path, exclude, (path: string, isDir: boolean) => {
			if (isDir) {
				return
			}
	
			let ok = false
			for (const ext of extensions) {
				if (path.endsWith(ext)) {
					ok = true
					break
				}
			}
			if (!ok) {
				return
			}
	
			if (exclude && exclude.length > 0) {
				let ok = true
				for (const exc of exclude) {
					if (path.endsWith(exc)) {
						ok = false
						break
					}
				}
				if (!ok) {
					return
				}
			}
	
			files.push(path)
		})
	}

	return files
}

function minifyHTML(data: string): string {
	return htmlMinifier.minify(data, {
		collapseWhitespace: true,
		removeAttributeQuotes: true,
		removeComments: true,
		minifyJS: true,
	})
}

function writeFile(path: string, data: string, compress: CompressKinds): void {
	if (compress === 'brotli') {
		fs.writeFileSync(`${path}.br`, zlib.brotliCompressSync(data))
		return
	}
	if (compress === 'gzip') {
		fs.writeFileSync(`${path}.gz`, zlib.gzipSync(data))
		return
	}

	fs.writeFileSync(path, data)
}

function concatFiles(files: File[]): string {
	return files.reduce((acc, f) => f.data + acc, '')
}

function removeFirstDir(path: string): string {
	return path.replace(/.+?\//, '')
}

function pathToRoute(path: string): string {
	return `/${removeFirstDir(path).replace(/index\.html$/, '')}`
}