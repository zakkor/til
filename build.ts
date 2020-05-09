import fs from 'fs'
import filepath from 'path'
import htmlMinifier from 'html-minifier'
import uglifyJS from 'uglify-js'
import imagemin from 'imagemin'
import imageminWebp from 'imagemin-webp'

import nodeHTMLParser, { Node as HTMLNode, HTMLElement } from 'node-html-parser'
import cssTree, { CssNode as CSSNode } from 'css-tree'

import { watch, File, collectFiles, writeFile, walktop } from './fs'
import { Config, readConfig, CompressKinds } from './config'
import { rip } from './rip'

// Options specified through env vars or as command-line arguments
type Options = {
	configPath: string
	prod: boolean
}

type Routes = {
	[index: string]: string
}

export type HTMLFile = {
	file: File
	root: HTMLNode
}

export type CSSFile = {
	file: File
	root: CSSNode
}

function build({ prod, configPath }: Options) {
	const cfg = readConfig(configPath, prod)
	const taskv = (name: string, fn: () => void) => {
		task(name, cfg.verbose, fn)
	}

	let pages = collectFiles(['./pages'], ['.html'])
	let styles = collectFiles(['./pages', './styles'], ['.css'])
	let scripts = collectFiles(['./pages'], ['.js'])

	resetOutputDir()

	taskv('components', () => processComponents(pages))
	let parsed: { pages: HTMLFile[], styles: CSSFile[] }
	taskv('parsing', () => {
		parsed = parseFiles(pages, styles)
	})
	taskv('images', () => processImages(parsed.pages))
	taskv('pages', () => processPages(parsed.pages, parsed.styles, cfg))
	taskv('scripts', () => processScripts(scripts, prod, cfg.compress))
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

function parseFiles(pages: File[], styles: File[]): { pages: HTMLFile[], styles: CSSFile[] } {
	let parsed = {
		pages: pages.map(page => {
			const root = nodeHTMLParser(page.data, { script: true, style: true })
			return { file: page, root }
		}),
		styles: styles.map(css => {
			// Parse given CSS file into an AST
			return { file: css, root: cssTree.parse(css.data) }
		}),
	}
	return parsed
}

function processImages(pages: HTMLFile[]) {
	const acceptedExtensions = ['.jpg', '.png']
	for (const page of pages) {
		walkHTML(page.root, (el: HTMLElement) => {
			if (el.tagName != 'img') {
				return
			}
			if (!('src' in el.attributes)) {
				return
			}
			const src = el.attributes.src
			const extension = src.substring(src.lastIndexOf('.'), src.length)
			if (!acceptedExtensions.includes(extension)) {
				return
			}

			let path = src
			if (path[0] === '/') {
				path = path.slice(1)
			}

			// create output dir
			const dirname = filepath.join('dist', filepath.dirname(path))
			fs.mkdirSync(dirname, { recursive: true })
			// convert to webp and write to file
			imagemin([path], {
				destination: dirname,
				plugins: [imageminWebp({
					lossless: true // Losslessly encode images
				})]
			})
			const srcwebp = src.slice(0, src.length - extension.length) + '.webp'
			// copy original image
			fs.copyFileSync(path, filepath.join(dirname, filepath.basename(path)))

			// <source media="(max-width: 799px)" srcset="/assets/images/varanghelia50p.jpg">
			const pictureNode = nodeHTMLParser(`<picture>
				<source srcset="${srcwebp}">
				<source srcset="${src}">
				<img src="${src}">
			</picture>`)
			const parent = el.parentNode as HTMLElement
			parent.exchangeChild(el, pictureNode)
		})
	}
}


function processPages(pages: HTMLFile[], styles: CSSFile[], cfg: Config) {
	// Use `rip` to process HTML and CSS
	// CSS is inlined within each HTML file by default
	pages = rip(pages, styles, {
		uglify: cfg.uglify,
		removeUnusedCSS: cfg.removeUnusedCSS,
	})

	// Minify pages HTML
	if (cfg.uglify) {
		for (const page of pages) {
			page.file.data = htmlMinify(page.file.data)
		}
	}

	if (cfg.navigationSPA) {
		prepareNavigation(pages, cfg.uglify, cfg.compress)
	}

	for (const page of pages) {
		let path = removeFirstDir(page.file.path)
		const outpath = filepath.join('dist', path)
		const outdir = filepath.dirname(outpath)

		// Create dir
		fs.mkdirSync(outdir, { recursive: true })
		// Write HTML to file
		writeFile(outpath, page.file.data, cfg.compress)
	}
}

function prepareNavigation(pages: HTMLFile[], uglify: boolean, compress: CompressKinds): void {
	let navigation = fs.readFileSync(filepath.join(__dirname, '..', 'navigation.js'), 'utf8')
	if (uglify) {
		navigation = uglifyJS.minify(navigation).code
	}

	const routes = prepareRoutes(pages)

	for (const page of pages) {
		// Delete this page from routes, we can add the page HTML to the routes after the page loads
		let pageRoutes = Object.assign({}, routes)
		delete (pageRoutes[pathToRoute(page.file.path)])
		const routesJSON = JSON.stringify(pageRoutes)

		fs.mkdirSync(`./dist/_til/nav/${pathToRoute(page.file.path)}`, { recursive: true })
		writeFile(`./dist/_til/nav/${pathToRoute(page.file.path)}/routes.json`, routesJSON, compress)

		// Add navigation
		page.file.data = page.file.data.replace('</body>', `<script>${navigation}</script></body>`)
	}
}

function prepareRoutes(pages: HTMLFile[]): Routes {
	let routes: Routes = {}
	for (const page of pages) {
		routes[pathToRoute(page.file.path)] = page.file.data
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

export function walkHTML(node: HTMLNode, fn: (el: HTMLElement) => void) {
	const el = node as HTMLElement
	if (el) {
		fn(el)
	}

	for (const c of node.childNodes) {
		walkHTML(c, fn)
	}
}

export function task(name: string, verbose: boolean, fn: () => void) {
	if (verbose === false) {
		fn()
		return
	}

	process.stdout.write(name + '... ')
	const start = process.hrtime()
	fn()
	const end = process.hrtime(start)

	// If time is under a second, format like "340ms"
	let fmt = `${(end[1] / 1e6).toPrecision(3)}ms`
	if (end[0] > 0) {
		// Otherwise, format like "3.150s"
		fmt = `${end[0]}${(end[1] / 1e9).toPrecision(3).toString().slice(1)}s`
	}
	console.log(`OK ${fmt}`)
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
