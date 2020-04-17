const fs = require('fs')
const path = require('path')

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

fs.mkdir('./dist', async () => {
	let routes = {}

	// Create a map of each page and its contents
	walk('./pages', (filepath, isDir) => {
		if (isDir) {
			return
		}
		
		const buf = fs.readFileSync(filepath)
		const r = filepath.replace(/.+?\//, '/').replace(/\/index.html$/, '/')
		routes[r] = buf.toString()
	})

	// Append routes to navigation template, and close the script.
	routes = JSON.stringify(routes)
	const navigation = navigationTemplate + `; const r = ${routes} </script>`
	
	// First, create all output directories
	walk('./pages', (filepath, isDir) => {
		if (!isDir) {
			return
		}
		// remove leading pages/
		filepath = filepath.replace(/.+?\//, '/')
		
		fs.mkdirSync(`./dist/${filepath}`, { recursive: true })
	})
	
	// Read head.html
	const headbuf = fs.readFileSync('head.html')
	htmlTemplate = htmlTemplate.replace('<%head%>', headbuf.toString())
	
	// Create all output pages
	walk('./pages', (filepath, isDir) => {
		if (isDir) {
			return
		}

		const buf = fs.readFileSync(filepath)
		
		// remove leading pages/
		filepath = filepath.replace(/.+?\//, '/')
		
		let template = htmlTemplate.replace('<%navigation%>', navigation)
		template = template.replace('<%body%>', buf.toString())
		
		fs.writeFileSync(`./dist/${filepath}`, template)
	})
})