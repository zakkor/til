const fs = require('fs')
const csstree = require('css-tree')
const htmlparse = require('node-html-parser')
const R = require('ramda')

// A list of .html and .css files.
// Ordering does not matter, but file extension does.
const inputFiles = process.argv.slice(2)

// classnames contains information about the class name nodes appearing in all input files.
// `count` is the number of times each class name appears, created first when parsing HTML
// and updated when parsing CSS.
// `total` is the number of bytes occupied by this classname in both HTML and CSS files, created only after parsing CSS.
const classnames = {}

// Iterate through all HTML files and parse their contents,
// collecting information about different node types.
inputFiles
	.filter(f => f.endsWith('.html'))
	.forEach(f => {
		const data = fs.readFileSync(f, 'utf8')
		parseHTML(classnames, data)
	})

// Iterate through all CSS files and parse their contents,
// collecting more information about different node types.
// Concatenate results into a string of css file contents.
const concat = inputFiles
	.filter(f => f.endsWith('.css'))
	.map(f => {
		const data = fs.readFileSync(f, 'utf8')
		return parseCSS(classnames, data)
	})
	.reduce((x, acc) => x + acc)

function parseHTML(classNodes, contents) {
	const el = htmlparse.parse(contents)
	addNodeChildren(classNodes, el)
}

function addNodeChildren(classnames, el) {
	for (const child of el.childNodes) {
		if (child.classNames == undefined) {
			continue
		}

		for (const className of child.classNames) {
			if (className in classnames) {
				classnames[className].count++
				continue
			}

			classnames[className] = { count: 1 }
		}

		if (child.childNodes.length > 0) {
			addNodeChildren(classnames, child)
		}
	}
}

function parseCSS(classnames, data) {
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

				node.name = generateShortestName(i)
			}
		})
	}

	return csstree.generate(ast)
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