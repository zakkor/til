import fs from 'fs'
import filepath from 'path'
import htmlMinifier from 'html-minifier'
import uglifyJS from 'uglify-js'
import zlib from 'zlib'
import { rip, RipExternalCSSResult, RipInlineCSSResult } from './styleripper'

const ComponentRegex = /<%(.+)%>/g

let HtmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
<%head%>
</head>
<body>
<div id="root">
<%root%>
</div>
<%navigation%>
</body>
</html>`

const NavigationTemplate = `var root = document.querySelector('#root')
function d() {
	document.querySelectorAll('a[href]').forEach(function(e) { e.onclick = g })
}
function g(e) {
	var t = e.target.closest('a[href]')
	var p = typeof e == 'object' ? t.getAttribute('href') : e
	if (!(p in r)) {
		return false
	}
	root.innerHTML = r[p]
	history.pushState({}, '', p)
	d()
	return false
}
window.onpopstate = function() {
	g(location.pathname)
}
d()
<%routes%>
r[location.pathname] = root.innerHTML`

export type File = {
	path: string
	data: string
}

type BuildOptions = {
	prod: boolean
}

type WalkFn = (path: string, isDir: boolean) => void
type WatchFn = (path: string) => void

function build({ prod }: BuildOptions) {
	// Read head.html
	const head = fs.readFileSync('head.html', 'utf8')
	HtmlTemplate = HtmlTemplate.replace('<%head%>', head)

	// Gather the files we need to process
	let files: File[] = collect('./pages', ['.html', '.css', '.js'])
		.concat(collect('./styles', ['.css']))
		.concat(collect('./static', ['.svg']))
		.map(f => { return { path: f, data: fs.readFileSync(f, 'utf8') } })

	const keep = (ext: string) => {
		return (f: File) => f.path.endsWith(ext)
	}
	let htmlFiles = files.filter(keep('.html'))
	let cssFiles = files.filter(keep('.css'))
	let jsFiles = files.filter(keep('.js'))
	let images = files.filter(keep('.svg'))

	htmlFiles.forEach(page => {
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

	// Use Styleripper to uglify HTML and CSS
	if (prod) {
		const ripped = rip(htmlFiles, cssFiles, { mode: 'InlineCSS' })
		const rippedExternal = ripped as RipExternalCSSResult
		if (rippedExternal) {
			htmlFiles = rippedExternal.htmlFiles
			cssFiles = rippedExternal.cssFiles
			console.log('html', htmlFiles)
			console.log('css', cssFiles)
		}
		const rippedInline = ripped as RipInlineCSSResult
		if (rippedInline) {
			console.log('inline', rippedInline)
			return
		}
	}

	let routes: { [index: string]: string } = {}
	for (const page of htmlFiles) {
		let data = page.data
		if (prod) {
			data = minifyHTML(page.data)
		}
		routes[pathToRoute(page.path)] = data
	}

	// Ignore error if already exists
	fs.mkdirSync('./dist', { recursive: true })

	// Remove "dist" dir
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

	for (const page of htmlFiles) {
		// Append routes except self to navigation template, and close the script tag
		let pageRoutes = Object.assign({}, routes)
		// Delete this page from routes, we can add the page HTML to the routes after the page loads
		delete (pageRoutes[pathToRoute(page.path)])
		const routesJSON = JSON.stringify(pageRoutes)

		let navigation = NavigationTemplate.replace('<%routes%>', `var r = ${routesJSON}`)
		if (prod) {
			navigation = uglifyJS.minify(navigation).code
		}

		let template = HtmlTemplate.replace('<%navigation%>', `<script>${navigation}</script>`)
		template = template.replace('<%root%>', page.data)

		if (prod) {
			template = minifyHTML(template)
		}

		// Write HTML to file
		writeFile(`./dist/${removeFirstDir(page.path)}`, template, prod)
	}

	// Write concatted CSS files
	const cssBundle = concatFiles(cssFiles)
	writeFile('./dist/bundle.css', cssBundle, prod)

	// Uglify JS, concat to bundle.js, and write to file.
	if (prod) {
		for (const f of jsFiles) {
			f.data = uglifyJS.minify(f.data).code
		}
	}
	const jsBundle = concatFiles(jsFiles)
	writeFile('./dist/bundle.js', jsBundle, prod)

	// Write static files
	fs.mkdirSync('./dist/static', { recursive: true })
	for (const img of images) {
		fs.writeFileSync(`./dist/${img.path}`, img.data)
	}
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

	const paths = collect('./', ['.html', '.css', '.js'], ['node_modules', 'dist'])
	for (const p of paths) {
		fs.watch(p, {}, watcher(p))
	}
}

module.exports = {
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

function collect(path: string, extensions: string[], exclude: string[] = []): string[] {
	let files: string[] = []
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

function writeFile(path: string, data: string, prod: boolean): void {
	if (prod) {
		fs.writeFileSync(`${path}.br`, zlib.brotliCompressSync(data))
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