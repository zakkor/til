const fs = require('fs')
const path = require('path')
const htmlMinifier = require('html-minifier').minify
const uglifyJS = require('uglify-js')
const zlib = require('zlib')
const rip = require('./styleripper')

fs.mkdir('./dist', async () => {
	// Read head.html
	const headbuf = fs.readFileSync('head.html')
	htmlTemplate = htmlTemplate.replace('<%head%>', headbuf.toString())

	const toProcess = collect('./pages', ['.html', '.css']).concat(collect('./styles', ['.css']))
	const ripped = rip(toProcess)

	let routes = {}
	for (const page of ripped.html) {
		routes[pathToRoute(page.path)] = minifyHTML(page.data)
	}

	// First, create all output directories
	walk('./pages', (filepath, isDir) => {
		if (isDir) {
			fs.mkdirSync(`./dist/${removeFirstDir(filepath)}`, { recursive: true })
		}
	})

	for (const page of ripped.html) {
		// Append routes except self to navigation template, and close the script tag.
		let selfRoutes = Object.assign({}, routes)
		delete(selfRoutes[pathToRoute(page.path)])
		selfRoutes = JSON.stringify(selfRoutes)

		let navigation = navigationTemplate.replace('<%routes%>', `var r = ${selfRoutes}`)
		
		// Uglify JS.
		navigation = uglifyJS.minify(navigation).code

		let template = htmlTemplate.replace('<%navigation%>', `<script>${navigation}</script>`)
		template = template.replace('<%body%>', page.data)

		// Minify HTML.
		const min = minifyHTML(template)
		
		// Write to file.
		writeFileCompressed(`./dist/${removeFirstDir(page.path)}`, min)
	}

	// Write CSS.
	writeFileCompressed(`./dist/${ripped.css.path}`, ripped.css.data)
})

let htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
<%head%>
</head>
<body>
<div id="root"> <%body%> </div>
<%navigation%>
</body>
</html>`

const navigationTemplate = `var root = document.querySelector('#root')
function d() {
  document.querySelectorAll('a[href]').forEach(function(e) { e.onclick = g })
}
function g(e) {
  var p = typeof e == 'object' ? e.target.getAttribute('href') : e
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

// Call function on every file.
function walk(d, fn) {
	const dir = fs.opendirSync(d)

	let dirent = null
	while (dirent = dir.readSync()) {
		if (dirent === null) {
			break
		}

		const full = path.join(d, dirent.name)
		if (dirent.isDirectory()) {
			fn(full, true) // is dir
			walk(full, fn)
		} else {
			fn(full, false) // is not dir
		}
	}
}

function collect(path, extensions) {
	let files = []
	walk(path, (filepath, isDir) => {
		if (isDir) {
			return
		}

		let ok = false
		for (const ext of extensions) {
			if (filepath.endsWith(ext)) {
				ok = true
				break
			}
		}
		if (!ok) {
			return
		}

		files.push(filepath)
	})
	return files
}

function minifyHTML(data) {
	return htmlMinifier(data, {
		collapseWhitespace: true,
		removeAttributeQuotes: true,
		removeComments: true,
	})
}

function writeFileCompressed(path, data) {
	const compr = zlib.brotliCompressSync(data)
	fs.writeFileSync(`${path}.br`, compr)
}

function removeFirstDir(p) {
	return p.replace(/.+?\//, '')
}

function pathToRoute(p) {
	return `/${removeFirstDir(p).replace(/index\.html$/, '')}`
}