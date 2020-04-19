const fs = require('fs')
const path = require('path')
const rip = require('./styleripper')

fs.mkdir('./dist', async () => {
	// Read head.html
	const headbuf = fs.readFileSync('head.html')
	htmlTemplate = htmlTemplate.replace('<%head%>', headbuf.toString())

	const toProcess = collect('./pages', ['.html', '.css']).concat(collect('./styles', ['.css']))
	const ripped = rip(toProcess)

	let routes = {}
	for (const page of ripped.html) {
		const r = ('/' + removeFirstDir(page.path)).replace(/\/index.html$/, '/')
		routes[r] = page.data
	}


	// First, create all output directories
	walk('./pages', (filepath, isDir) => {
		if (isDir) {
			fs.mkdirSync(`./dist/${removeFirstDir(filepath)}`, { recursive: true })
		}
	})

	for (const page of ripped.html) {
		// Append routes except self to navigation template, and close the script tag.
		let troutes = Object.assign({}, routes)
		const r = ('/' + removeFirstDir(page.path)).replace(/\/index.html$/, '/')
		delete(troutes, r)
		console.log('troutes', troutes)
		console.log('r', r)
		troutes = JSON.stringify(troutes)

		const navigation = navigationTemplate + `; const r = ${troutes} </script>`
		let template = htmlTemplate.replace('<%navigation%>', navigation)
		template = template.replace('<%body%>', page.data)
		fs.writeFileSync(`./dist/${removeFirstDir(page.path)}`, template)
	}

	// Write CSS.
	fs.writeFileSync(`./dist/${ripped.css.path}`, ripped.css.data)
})

let htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
<%head%>
</head>
<body>
<%body%>
<%navigation%>
</body>
</html>
`

// <script> will be closed after we append the routes
const navigationTemplate = `<script>
function run() {
  document.querySelectorAll('a[href]').forEach(e => { e.onclick = go })
}
function go(e) {
  const p = typeof e == 'object' ? e.target.getAttribute('href') : e
  document.querySelector('body').innerHTML = r[p]
  history.pushState({}, '', p)
  run()
  return false
}
window.onpopstate = function() {
  go(location.pathname)
}
run()
`

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

function removeFirstDir(p) {
	return p.replace(/.+?\//, '')
}