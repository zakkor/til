import fs from 'fs'
import filepath from 'path'
import htmlMinifier from 'html-minifier'
import uglifyJS from 'uglify-js'

import { watch, File, collectFiles, writeFile, walk, walktop } from './fs'
import { readConfig, CompressKinds } from './config'
import { rip } from './rip'

// Options specified through env vars or as command-line arguments
type Options = {
	configPath: string
	prod: boolean
}

type Routes = {
	[index: string]: string
}

function build({ prod, configPath }: Options) {
	const cfg = readConfig(configPath, prod)

	resetOutputDir()

	let pages = collectFiles(['./pages'], ['.html'])
	let styles = collectFiles(['./pages', './styles'], ['.css'])
	let scripts = collectFiles(['./pages'], ['.js'])

	processComponents(pages)
	processPages(pages, styles, prod, cfg.compress)
	processScripts(scripts, prod, cfg.compress)
}

// Go through each component and substitute in pages
function processComponents(pages: File[]): void {
	const comps = collectFiles(['./components'], ['.html'])
	for (const comp of comps) {
		const name = filepath.basename(comp.path).slice(0, -5) // remove ".html"
		for (const page of pages) {
			// Match each component name, specified like "<%component%>"
			page.data = page.data.replace(new RegExp(`<%${name}%>`, 'g'), comp.data)
		}
	}
}

function processPages(pages: File[], styles: File[], prod: boolean, compress: CompressKinds) {
	// Use `rip` to process HTML and CSS
	// CSS is inlined within each HTML file by default
	// If minify is true, node names will be minified
	pages = rip(pages, styles, {
		// Minify in production
		minify: prod,
	})

	prepareNavigation(pages, prod, compress)

	for (const page of pages) {
		let path = removeFirstDir(page.path)
		const outpath = filepath.join('dist', path)
		const outdir = filepath.dirname(outpath)

		// Create dir
		fs.mkdirSync(outdir, { recursive: true })
		// Write HTML to file
		writeFile(outpath, page.data, compress)
	}
}

function prepareNavigation(pages: File[], prod: boolean, compress: CompressKinds): void {
	let navigation = fs.readFileSync(filepath.join(__dirname, '..', 'navigation.js'), 'utf8')
	if (prod) {
		navigation = uglifyJS.minify(navigation).code
	}

	const routes = prepareRoutes(pages, prod)

	for (const page of pages) {
		// Delete this page from routes, we can add the page HTML to the routes after the page loads
		let pageRoutes = Object.assign({}, routes)
		delete (pageRoutes[pathToRoute(page.path)])
		const routesJSON = JSON.stringify(pageRoutes)

		fs.mkdirSync(`./dist/_til/nav/${pathToRoute(page.path)}`, { recursive: true })
		writeFile(`./dist/_til/nav/${pathToRoute(page.path)}/routes.json`, routesJSON, compress)

		// Add navigation
		page.data = page.data.replace('</body>', `<script>${navigation}</script></body>`)
	}
}

function prepareRoutes(pages: File[], prod: boolean): Routes {
	let routes: Routes = {}
	for (const page of pages) {
		// TODO: maybe html minification should be done in a step before this one
		// instead of as a side effect of preparing routes
		if (prod) {
			page.data = htmlMinify(page.data)
		}
		routes[pathToRoute(page.path)] = page.data
	}

	return routes
}

function processScripts(scripts: File[], prod: boolean, compress: CompressKinds): void {
	// Uglify JS, concat, and write to bundle.js.
	if (prod) {
		for (const f of scripts) {
			f.data = uglifyJS.minify(f.data).code
		}
	}
	const jsBundle = concatFiles(scripts)
	if (jsBundle !== '') {
		writeFile('./dist/bundle.js', jsBundle, compress)
	}
}

export default {
	build,
	watch,
}

function resetOutputDir() {
	// Make sure "dist" dir exists
	fs.mkdirSync('./dist', { recursive: true })
	// Remove each item in "dist" dir
	walktop('./dist', (path, isDir) => {
		if (isDir) {
			fs.rmdirSync(path, { recursive: true })
			return
		}
		fs.unlinkSync(path)
	})
}

function htmlMinify(data: string): string {
	return htmlMinifier.minify(data, {
		collapseWhitespace: true,
		removeAttributeQuotes: true,
		removeComments: true,
		minifyJS: true,
	})
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