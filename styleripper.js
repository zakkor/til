const fs = require('fs')
const path = require('path')
const csstree = require('css-tree')
const htmlparse = require('node-html-parser')
const R = require('ramda')

// A list of .html and .css files.
// Ordering does not matter, but file extension does.
const inputFiles = process.argv.slice(2)
function readFiles(files, extension) {
	return files.filter(f => f.endsWith(extension)).map(f => { return { name: f, data: fs.readFileSync(f, 'utf8') } })
}
const htmlFiles = readFiles(inputFiles, '.html')
const cssFiles = readFiles(inputFiles, '.css')

// classnames contains information about the class name nodes appearing in all input files.
// `count` is the number of times each class name appears, created first when parsing HTML
// and updated when parsing CSS.
// `total` is the number of bytes occupied by this classname in both HTML and CSS files, created only after parsing CSS.
const classnames = {}
// renames contains information describing which nodes to rename to what
const rename = {
	classnames: {} // { 'from': 'to' }
}

// Iterate through all HTML files and parse their contents,
// collecting information about different node types.
htmlFiles.forEach(f => {
	parseHTML(classnames, f.data)
})

// Iterate through all CSS files and parse their contents,
// collecting more information about different node types.
// Before walking the AST, all unused classnames are removed.
// Afterwards, nodes are renamed and recorded in `rename`, and the resulting CSS is returned.
// Concatenate results into a string of all CSS file contents.
const css = cssFiles.map(f => {
	return parseAndProcessCSS(classnames, rename, f.data)
}).reduce((x, acc) => x + acc, '')

// Write concatted CSS to file.
const p = `./dist/built.css`
fs.mkdirSync(path.dirname(p), { recursive: true })
fs.writeFileSync(p, css)

// Go through HTML files again, and rewrite all nodes according to `rename`.
// Gather each file's rewritten content in an array.
const html = htmlFiles.map(f => {
	const node = htmlparse.parse(f.data)
	processHTMLNodeChildren(rename, node)
	return node.toString()
})

// Write each rewritten HTML to its own file.
html.forEach((h, i) => {
	const p = `./dist/${htmlFiles[i].name}`
	fs.mkdirSync(path.dirname(p), { recursive: true })
	fs.writeFileSync(p, h)
})

function parseHTML(classnames, data) {
	const node = htmlparse.parse(data)
	parseHTMLNodeChildren(classnames, node)
}

function parseHTMLNodeChildren(classnames, node) {
	// Count each className occurrence.
	if (node.classNames) {
		for (const className of node.classNames) {
			if (className in classnames) {
				classnames[className].count++
				continue
			}
			classnames[className] = { count: 1 }
		}
	}

	for (const child of node.childNodes) {
		parseHTMLNodeChildren(classnames, child)
	}
}

function parseAndProcessCSS(classnames, rename, data) {
	// Parse given CSS file into an AST.
	const ast = csstree.parse(data)

	// Walk AST and remove rules in which the only selector is an unused class.
	csstree.walk(ast, {
		visit: 'Rule',
		enter: function (node, parentItem, parentList) {
			node.prelude.children.each((selector, item, list) => {
				// Remove any unused class selectors from SelectorList
				selector.children.each((s) => {
					if (s.type !== 'ClassSelector' || s.name in classnames) {
						return
					}

					list.remove(item)
				})

				// We've removed all the selectors, need to remove entire rule.
				if (list.isEmpty()) {
					parentList.remove(parentItem)
				}
			})
		}
	})

	// Walk through all class selectors and increment their count.
	// (Only if they are used, as we have already removed all unused classnames)
	csstree.walk(ast, {
		visit: 'ClassSelector',
		enter: function (node) {
			if (!(node.name in classnames)) {
				throw new Error('encountered unused class selector when it should have been removed')
			}

			classnames[node.name].count++
		}
	})

	// Calculate the total byte size of each classname (count * name length) and collect it into an array so we can sort it.
	let sorted = Object.entries(classnames)
		.map(([name, sel]) => {
			return { name, total: name.length * sel.count }
		}).sort((a, b) => b.total - a.total)

	// For each selector in sorted order, walk through AST and rename each occurrence.
	for (const [i, sel] of sorted.entries()) {
		csstree.walk(ast, {
			visit: 'ClassSelector',
			enter: function (node) {
				if (node.name !== sel.name) {
					return
				}

				const name = generateShortestName(i)
				rename[node.name] = name
				node.name = name
			}
		})
	}

	return csstree.generate(ast)
}

function processHTMLNodeChildren(rename, node) {
	if (node.classNames) {
		const replace = node.classNames.map(c => {
			if (c in rename) {
				return rename[c]
			}

			return c
		})

		if (replace.length > 0) {
			node.setAttribute('class', replace.join(' '))
		}
	}

	for (const child of node.childNodes) {
		processHTMLNodeChildren(rename, child)
	}
}

function generateShortestName(idx) {
	// fill with a-z
	const letters =
		R.range(97, 123)
			.map(c => String.fromCharCode(c))

	let timesOver = 0
	while (idx >= letters.length) {
		timesOver++

		idx -= letters.length
	}

	if (timesOver) {
		return letters[idx] + (timesOver - 1)
	}

	return letters[idx]
}