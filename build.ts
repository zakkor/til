import fs from 'fs'
import util from 'util'
import filepath from 'path'
import htmlMinifier from 'html-minifier'
import uglifyJS from 'uglify-js'
import sharp from 'sharp'
import SVGO from 'svgo'
import nodeHTMLParser, { Node as HTMLNode, HTMLElement } from 'node-html-parser'
import cssTree, { CssNode as CSSNode } from 'css-tree'

import { watch, File, collect, collectFiles, writeFile, walktop } from './fs'
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

type PromiseFunc = () => Promise<void>
type VoidFunc = () => void

async function build({ prod, configPath }: Options) {
	const cfg = readConfig(configPath, prod)
	const taskv = async (name: string, fn: PromiseFunc | VoidFunc) => {
		await task(name, cfg.verbose, fn)
	}

	let pages = collectFiles(['./pages'], ['.html'])
	let styles = collectFiles(['./pages', './styles'], ['.css'])
	let scripts = collectFiles(['./pages'], ['.js'])

	resetOutputDir()

	await taskv('components', () => processComponents(pages))

	let parsed: { pages: HTMLFile[], styles: CSSFile[] }
	await taskv('parsing', () => {
		parsed = parseFiles(pages, styles)
	})

	await taskv('images', async () => {
		await processImages(parsed.pages, cfg)
	})

	await taskv('svgs', async () => {
		await processSVGs(parsed.pages, cfg)
	})

	await taskv('fonts', async () => {
		await processFonts()
	})

	await taskv('pages', async () => {
		await processPages(parsed.pages, parsed.styles, cfg)
	})

	await taskv('scripts', () => processScripts(scripts, prod, cfg.compress))
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

async function processImages(pages: HTMLFile[], cfg: Config) {
	const acceptedExtensions = ['.jpg', '.png']
	for (const page of pages) {
		await walkHTML(page.root, async (el: HTMLElement) => {
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

			// is like "assets/images/cat.png"
			let path = src
			if (path[0] === '/') {
				path = path.slice(1)
			}

			const removeExtension = (path: string) => {
				return path.slice(0, path.length - extension.length)
			}

			const dirname = filepath.join('dist', filepath.dirname(path)) // is like "dist/assets/images"
			const pathnoext = removeExtension(path) // is like "assets/images/cat"
			const pathwebp = pathnoext + '.webp' // is like "assets/images/cat.webp"
			const outpathwebp = filepath.join('dist', pathwebp) // is like "dist/assets/images/cat.webp"
			const srcwebp = '/' + pathwebp // is like "/assets/images/cat.webp"
			const imageType = `image/${extension.slice(1)}` // is like "image/png"

			// Create output dir
			fs.mkdirSync(dirname, { recursive: true })

			// Always copy original file
			fs.copyFileSync(path, filepath.join('dist', path))

			let mediaQueries: MediaQuery[] | null = null
			if (cfg.images.responsive) {
				mediaQueries = await writeResponsiveImages(path)
			}

			let picture = '<picture>'
			// Add webp <source> elements
			if (cfg.images.webp) {
				// Convert image to webp and write to file
				await sharp(path)
					.toFile(outpathwebp)

				if (cfg.images.responsive && mediaQueries !== null) {
					for (const mq of mediaQueries) {
						// Convert to webp
						const srcwebp = removeExtension(mq.path) + '.webp'
						const resppathwebp = filepath.join('dist', srcwebp)
						await sharp(filepath.join('dist', mq.path))
							.toFile(resppathwebp)
						picture += `<source type="image/webp" media="${mq.query}" srcset="/${srcwebp}">`
					}
				}

				picture += `<source type="image/webp" srcset="${srcwebp}">`
			}
			// Add default <source>
			if (cfg.images.responsive && mediaQueries !== null) {
				for (const mq of mediaQueries) {
					picture += `<source type="${imageType}" media="${mq.query}" srcset="/${mq.path}">`
				}
			}
			picture += `<img loading="lazy" src="${src}">`
			picture += '</picture>'

			// TODO: copy attributes like in SVGs case if needed
			if (cfg.images.responsive || cfg.images.webp) {
				const pictureNode = nodeHTMLParser(picture)
				const parent = el.parentNode as HTMLElement
				parent.exchangeChild(el, pictureNode)
			}
		})
	}
}

async function processSVGs(pages: HTMLFile[], cfg: Config) {
	for (const page of pages) {
		await walkHTML(page.root, async (el: HTMLElement) => {
			if (el.tagName != 'img') {
				return
			}
			if (!('src' in el.attributes)) {
				return
			}
			const src = el.attributes.src
			const extension = src.substring(src.lastIndexOf('.'), src.length)
			if (extension != '.svg') {
				return
			}

			// is like "assets/images/icon.svg"
			let path = src
			if (path[0] === '/') {
				path = path.slice(1)
			}

			let svg = fs.readFileSync(path, 'utf8')
			const svgo = new SVGO({
				plugins: [{ removeDoctype: true }, { removeXMLProcInst: true },
				{ removeComments: true }, { removeMetadata: true },
				{ removeTitle: true }, { removeDesc: true },
				{ removeUselessDefs: true }, { removeEditorsNSData: true },
				{ removeEmptyAttrs: true }, { removeHiddenElems: true },
				{ removeEmptyText: true }, { removeEmptyContainers: true },
				{ removeViewBox: false }, { cleanupEnableBackground: true },
				{ convertStyleToAttrs: true }, { convertColors: true },
				{ convertPathData: true }, { convertTransform: true },
				{ removeUnknownsAndDefaults: true }, { removeNonInheritableGroupAttrs: true },
				{ removeUselessStrokeAndFill: true }, { removeUnusedNS: true },
				{ cleanupIDs: true }, { cleanupNumericValues: true },
				{ moveElemsAttrsToGroup: true }, { moveGroupAttrsToElems: true },
				{ collapseGroups: true }, { removeRasterImages: false },
				{ mergePaths: true }, { convertShapeToPath: true },
				{ sortAttrs: true }, { removeDimensions: true },
				{ removeAttrs: { attrs: '(stroke|fill)' } }, { cleanupAttrs: true }]
			})

			if (cfg.svgs.optimize) {
				const optimized = await svgo.optimize(svg)
				svg = optimized.data
			}

			const dirname = filepath.join('dist', filepath.dirname(path)) // is like "dist/assets/images"
			// Create output dir
			fs.mkdirSync(dirname, { recursive: true })
			
			// Write file too, it may be used by CSS.
			fs.writeFileSync(filepath.join('dist', path), svg, 'utf8')

			if (!cfg.svgs.inline) {
				return
			}

			el.removeAttribute('src')
			const attrs = el.attributes as {
				[key: string]: string;
			}

			const svgEl = (nodeHTMLParser(svg) as HTMLElement).firstChild as HTMLElement
			for (const [k, v] of Object.entries(attrs)) {
				svgEl.setAttribute(k, v)
			}

			const parent = el.parentNode as HTMLElement
			parent.exchangeChild(el, svgEl)
		})
	}
}

async function processFonts() {
	const copyFile = util.promisify(fs.copyFile)
	const mkdir = util.promisify(fs.mkdir)

	const fonts = collect(['./assets/fonts'], ['.woff2', '.woff', '.ttf'])
	const outdir = filepath.join('dist', 'assets', 'fonts')

	let pxs: Promise<void>[] = []
	const pr = mkdir(outdir)
	pxs.push(pr)
	for (const f of fonts) {
		const pr = copyFile(f, filepath.join('dist', f))
		pxs.push(pr)
	}
	await Promise.all(pxs)
}

type MediaQuery = {
	query: string
	path: string
}

async function writeResponsiveImages(path: string): Promise<MediaQuery[]> {
	const breakpoints = [
		{ name: 'sm', size: 640 },
		{ name: 'md', size: 768 },
		{ name: 'lg', size: 1024 },
		{ name: 'xl', size: 1280 },
	]
	// Percentage of BP to resize to.
	// If we are on a 640px wide screen, we would serve a (640 * 0.75) pixels wide image.
	const resizePercentage = 0.75

	const { width } = await sharp(path)
		.metadata()

	if (width === undefined) {
		throw new Error('cannot detect image width')
	}

	let assigned: (number | null)[] = [
		null,
		null,
		null,
		null,
	]

	let a = 0
	for (const bp of breakpoints) {
		if (width < bp.size) {
			break
		}

		assigned[a] = bp.size * resizePercentage
		a++
	}

	let mediaQueries: MediaQuery[] = []
	let alreadyResized: number[] = [width]
	for (let i = 0; i < assigned.length; i++) {
		const size = assigned[i]
		if (size === null) {
			continue
		}
		if (alreadyResized.includes(size)) {
			continue
		}

		const bp = breakpoints[i]
		const resizedPath = resizedImagePath(path, bp.name)

		await sharp(path)
			.resize(size)
			.toFile(filepath.join('dist', resizedPath))

		mediaQueries.push({ query: `(max-width: ${bp.size}px)`, path: resizedPath })
		alreadyResized.push(size)
	}

	return mediaQueries
}

function resizedImagePath(path: string, bp: string): string {
	const extension = path.substring(path.lastIndexOf('.'), path.length)
	const pathnoext = path.slice(0, path.length - extension.length)
	return pathnoext + '_' + bp + extension
}

async function processPages(pages: HTMLFile[], styles: CSSFile[], cfg: Config) {
	// Use `rip` to process HTML and CSS
	// CSS is inlined within each HTML file by default
	pages = await rip(pages, styles, {
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

export async function walkHTML(node: HTMLNode, fn: (el: HTMLElement) => Promise<void>) {
	const el = node as HTMLElement
	if (el) {
		await fn(el)
	}

	for (const c of node.childNodes) {
		await walkHTML(c, fn)
	}
}

export async function task(name: string, verbose: boolean, fn: PromiseFunc | VoidFunc) {
	if (verbose === false) {
		await fn()
		return
	}

	process.stdout.write(name + '... ')
	const start = process.hrtime()
	await fn()
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
