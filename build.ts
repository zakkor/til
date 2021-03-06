import fs from 'fs'
import util from 'util'
import filepath from 'path'
import htmlMinifier from 'html-minifier'
import uglifyJS from 'uglify-js'
import ttf2woff2 from 'ttf2woff2'
// @ts-ignore
import ttf2woff from 'ttf2woff'
// @ts-ignore
import ttf2eot from 'ttf2eot'
import sharp from 'sharp'
import SVGO from 'svgo'
import nodeHTMLParser, { Node as HTMLNode, HTMLElement } from 'node-html-parser'
import cssTree, { CssNode as CSSNode } from 'css-tree'

import {
	watch, File, collect, collectFiles,
	writeFileCompressed, walktop,
	walktopSync, fileExists, fileChanged,
	copyDirSync
} from './fs'
import { Config, readConfig, CompressKinds } from './config'
import { rip } from './rip'

const copyFile = util.promisify(fs.copyFile)
const readFile = util.promisify(fs.readFile)
const writeFile = util.promisify(fs.writeFile)
const mkdir = util.promisify(fs.mkdir)

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

	resetOutputDir()

	await taskv('components', () => processComponents(pages))

	await taskv('fonts', async () => {
		await processFonts(pages, cfg)
	})

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

	await taskv('pages', async () => {
		await processPages(parsed.pages, parsed.styles, cfg)
	})

	await taskv('scripts', () => processScripts(prod, cfg.compress))

	// Cache fonts so we don't have to generate them every time
	const distFontDir = filepath.join('dist', 'assets', 'fonts')
	if (fileExists(distFontDir)) {
		copyDirSync(distFontDir, filepath.join('.cache', 'assets', 'fonts'))
	}
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
	return {
		pages: pages.map(page => {
			const root = nodeHTMLParser(page.data, { script: true, style: true })
			return { file: page, root }
		}),
		styles: styles.map(css => {
			// Parse given CSS file into an AST
			return { file: css, root: cssTree.parse(css.data) }
		}),
	}
}

async function processImages(pages: HTMLFile[], cfg: Config) {
	const acceptedExtensions = ['.jpg', '.png']

	// TODO: add to queue to avoid copying the same file multiple times
	const images = collect([filepath.join('assets', 'images')], acceptedExtensions)
	for (const path of images) {
		// Create output dir
		await mkdir(filepath.join('dist', filepath.dirname(path)), { recursive: true })
		await copyFile(path, filepath.join('dist', path))
	}

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
			try {
				fs.copyFileSync(path, filepath.join('dist', path))
			} catch (err) {
				console.error(`image file "${path}" specified in <img> src attribute does not exist`)
				process.exit(1)
			}

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
		{ sortAttrs: true }, { removeDimensions: true }, { cleanupAttrs: true }]
	})

	// TODO: parse HTML <style> rules and CSS rules looking for url() elements referencing SVGs, and process only those?
	const svgs = collect([filepath.join('assets', 'images')], ['.svg'])
	for (const path of svgs) {
		// Create output dir
		await mkdir(filepath.join('dist', filepath.dirname(path)), { recursive: true })

		if (cfg.svgs.optimize) {
			const data = await readFile(path, 'utf8')
			const optimized = await svgo.optimize(data)
			await writeFile(filepath.join('dist', path), optimized.data)
			continue
		}

		await copyFile(path, filepath.join('dist', path))
	}

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

			let svg: string
			try {
				svg = fs.readFileSync(path, 'utf8')
			} catch (err) {
				console.error(`svg file "${path}" specified in <img> src attribute does not exist`)
				process.exit(1)
			}

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

class Font {
	family: string // "Roboto"
	style: string | undefined // "italic"
	weight: string | undefined // "400"
	formats: FontFormat[]

	constructor(family: string) {
		this.family = family
		this.formats = []
	}

	addFormat(name: FontFormatName, path: string) {
		let cssName: FontFormatCSSName
		switch (name) {
			case "ttf":
				cssName = "truetype"
				break
			case "woff":
				cssName = "woff"
				break
			case "woff2":
				cssName = "woff2"
				break
			case "eot":
				cssName = "embedded-opentype"
				break
		}
		this.formats.push({
			name,
			cssName,
			path,
		})
	}

	generateFontFace(appendPreloads: (preload: string) => void): string {
		let fontFace = `@font-face {
	font-family: '${this.family}';
	font-style: ${this.style};
	font-weight: ${this.weight};
	font-display: swap;\n`

		let addedSrc: boolean = false
		// ifExists will be called only if the font format exists
		const appendURL = (name: FontFormatName, ifExists?: (path: string) => void) => {
			const fmt = this.getFormat(name)
			if (!fmt) {
				return
			}

			if (ifExists) {
				ifExists(fmt.path)
			}

			// If the previous character is a ";", remove it and insert a "," and a newline instead (for enumerating more than one property)
			if (fontFace[fontFace.length - 1] === ';') {
				fontFace = fontFace.slice(0, -1) + ',\n'
			}
			if (!addedSrc) {
				fontFace += 'src: '
			}
			addedSrc = true
			fontFace += `url('/${removeFirstDir(fmt.path)}') format('${fmt.cssName}');`
		}

		// Generating .eot and .woff2 URLs are special cases
		const fmteot = this.getFormat('eot')
		if (fmteot) {
			const src = '/' + removeFirstDir(fmteot.path)
			fontFace += `src: url('${src}');
			src: url('${src}?#iefix') format('${fmteot.cssName}');`
			addedSrc = true
		}
		appendURL('woff2', (path: string) => {
			appendPreloads(`<link rel="preload" href="/${removeFirstDir(path)}" as="font" type="font/woff2">`)
		})
		appendURL('woff')
		appendURL('ttf')
		fontFace += '}'
		return fontFace
	}

	getFormat(name: FontFormatName): FontFormat | undefined {
		for (const fmt of this.formats) {
			if (fmt.name === name) {
				return fmt
			}
		}
		return undefined
	}
}

type FontFormat = {
	name: FontFormatName // "ttf"
	cssName: FontFormatCSSName // "truetype"
	path: string // "dist/assets/fonts/Roboto/normal-400.ttf"
}

type FontFormatName = "ttf" | "woff" | "woff2" | "eot"
type FontFormatCSSName = "truetype" | "woff" | "woff2" | "embedded-opentype"

async function processFonts(pages: File[], cfg: Config) {
	if (!fileExists(filepath.join('assets', 'fonts'))) {
		// If fonts dir doesn't exist, stop
		return
	}

	// TODO: refactor: `fontExtensions` and `requiredTypes` should be the same (no leading ".")
	const fontExtensions = ['.ttf', '.woff', '.woff2', '.eot']

	const isFont = (path: string) => {
		return fontExtensions.includes(filepath.extname(path))
	}

	await mkdir(filepath.join('dist', 'assets', 'fonts'), { recursive: true })
	let pxs: Promise<void>[] = []
	const fonts: Font[] = []

	await walktop('assets/fonts', async (path, isDir) => {
		// If there is a font file directly at the top level of the fonts folder, 
		// copy it directly, bypassing the rest of the process.
		if (!isDir) {
			if (isFont(path)) {
				pxs.push(copyFile(path, filepath.join('dist', path)))
			}

			return
		}

		await mkdir(filepath.join('dist', path))
		const family = filepath.basename(path)
		// TODO: refactor: get rid of `fontFormats` and use only `fonts`
		const fontFormats: { [index: string]: string[] } = {}

		walktopSync(path, (path, isDir) => {
			if (isDir) {
				return
			}

			const parts = filepath.basename(path).split('.')
			const name = parts[0]
			const ext = parts[1]

			if (!(name in fontFormats)) {
				fontFormats[name] = []
			}
			fontFormats[name].push(ext)

			// copy to dist
			const outpath = filepath.join('dist', path)
			pxs.push(copyFile(path, outpath))
		})

		const requiredTypes = fontExtensions.map(e => e.slice(1)) // remove leading "."

		for (const [name, types] of Object.entries(fontFormats)) {
			let font = new Font(family)
			const words = name.split('-')
			const style = words[0]
			const weight = words[1]
			font.style = style
			font.weight = weight
			const fontpath = filepath.join('dist', path, name)
			for (const t of types) {
				font.addFormat(t as FontFormatName, fontpath + '.' + t)
			}
			fonts.push(font)

			if (!cfg.fonts.convert) {
				continue
			}

			const haveTTF = types.includes('ttf')
			// If we don't have the .ttf file, we can't convert to other formats
			if (!haveTTF) {
				continue
			}
			const ttfPath = filepath.join(path, name) + '.ttf'
			const ttfbuf = await readFile(ttfPath)
			const needed = requiredTypes.filter(rt => !types.includes(rt))
			for (const n of needed) {
				const neededPath = filepath.join(path, name + '.' + n)
				const outpath = filepath.join('dist', neededPath)
				// If generated font is not cached
				if (fileChanged(ttfPath) || !fileExists(filepath.join('.cache', neededPath))) {
					if (cfg.verbose) {
						console.log(`generating "${n}" font for`, family, name)
					}
					let buf: Buffer
					switch (n) {
						case 'woff2':
							buf = ttf2woff2(ttfbuf)
							break
						case 'woff':
							buf = ttf2woff(ttfbuf).buffer as Buffer
							break
						case 'eot':
							buf = ttf2eot(ttfbuf).buffer as Buffer
							break
						default:
							throw new Error('unknown font type')
					}
					pxs.push(writeFile(outpath, buf))
				} else {
					// Copy from cache dir
					pxs.push(copyFile(filepath.join('.cache', neededPath), outpath))
				}
				font.addFormat(n as FontFormatName, outpath)
			}
		}
	})

	await Promise.all(pxs)

	let preloads = ''
	const fontFaces = fonts.map(f => {
		return f.generateFontFace((preload: string) => {
			preloads += preload
		})
	}).join('\n')

	for (const page of pages) {
		page.data = page.data.replace('<head>', `<head>${preloads}<style>${fontFaces}</style>`)
	}
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
		writeFileCompressed(outpath, page.file.data, cfg.compress)
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
		writeFileCompressed(`./dist/_til/nav/${pathToRoute(page.file.path)}/routes.json`, routesJSON, compress)

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

function processScripts(prod: boolean, compress: CompressKinds): void {
	const scripts = collectFiles(['./pages'], ['.js'])

	// Uglify JS, concat, and write to bundle.js.
	if (prod) {
		for (const f of scripts) {
			f.data = uglifyJS.minify(f.data).code
		}
	}
	const jsBundle = concatFiles(scripts)
	if (jsBundle !== '') {
		writeFileCompressed('./dist/bundle.js', jsBundle, compress)
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
	walktopSync('./dist', (path, isDir) => {
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
