import cssTree, { CssNode as CSSNode, List as CSSList, ListItem as CSSListItem } from 'css-tree'
import nodeHTMLParser, { Node as HTMLNode, HTMLElement } from 'node-html-parser'
import { File } from './fs'

type Options = {
	minify: boolean
}

type ParsedFile = {
	file: File
	ast: CSSNode | HTMLNode
}

type Occurrences = {
	typenames: NodeOccurrences
	classnames: NodeOccurrences
	ids: NodeOccurrences
}

type NodeOccurrences = {
	[index: string]: number
}

type Names = {
	classnames: string[]
	ids: string[]
}

// Mapping of which nodes were renamed from initial name to new name, for each node type.
// example: rename.classnames['col-lg-6'] // is 'b'
type Rename = {
	classnames: { [index: string]: string }
	ids: { [index: string]: string }
}

export function rip(htmlFiles: File[], cssFiles: File[], options: Options): File[] {
	// Store parsed CSS files here, and only clone them when needed to avoid parsing them multiple times
	const parsedCSS: ParsedFile[] = cssFiles.map(css => {
		// Parse given CSS file into an AST
		return { file: css, ast: cssTree.parse(css.data) }
	})

	const ripped = htmlFiles.map(html => {
		// Determine total node usage for this (HTML; CSS...) pair
		let nodes: Occurrences = {
			classnames: {},
			typenames: {},
			ids: {},
		}

		// Parse HTML into an AST, incrementing each occurrence of every renameable node.
		// Save AST on object to reuse later when renaming each node
		const ast = parseAndTrackHTMLNodes(nodes, html.data)

		let clonedCSS: ParsedFile[] = []
		parsedCSS.forEach(css => {
			const c = {
				file: css.file,
				ast: cssTree.clone(css.ast as CSSNode),
			}
			clonedCSS.push(c)
		})

		clonedCSS.forEach(css => {
			// Remove unused nodes, then increment each node occurrence
			processCSSNodes(nodes, css.ast as CSSNode)
		})

		// Calculate the total byte size of each node (n.count * n.name.length) and collect it into a sorted array
		let names = sortedNames(nodes)

		// Start keeping track of how we've renamed nodes for this HTML file
		let rename: Rename = {
			classnames: {},
			ids: {},
		}

		// CSS nodes are renamed and remembered in `rename`, and the resulting CSS is returned
		// Each HTML file gets its own bundle of CSS, so we concat the results
		const inlineCSS: string = clonedCSS.map(pcss => {
			let data = pcss.file.data
			if (options.minify) {
				data = renameCSSNodes(names, rename, (pcss.ast as CSSNode))
			}
			return {
				path: pcss.file.path,
				data,
			}
		}).reduce((acc, css) => css.data + acc, '')

		if (options.minify) {
			// Rewrite all nodes according to `rename`
			renameHTMLNodes(rename, ast)
		}

		let data = ast.toString()
		// Insert right where <body> starts
		data = data.replace('<body>', `<body><style>${inlineCSS}</style>`)
		return {
			path: html.path,
			data,
		}
	})
	return ripped
}

function processCSSNodes(nodes: Occurrences, ast: CSSNode): void {
	// Walk AST and remove rules in which the only selector is an unused class
	cssTree.walk(ast, {
		enter: function (node: CSSNode, parentItem: CSSListItem<CSSNode>, parentList: CSSList<CSSNode>) {
			// Remove comments
			if (node.type == 'Comment') {
				parentList.remove(parentItem)
				return
			}

			if (node.type == 'Rule') {
				const selList = node.prelude as cssTree.SelectorList
				if (!selList) {
					return
				}

				selList.children.each((selector, item, list) => {
					// Remove any unused class selectors from SelectorList
					(selector as cssTree.Selector).children.each((s) => {
						if (list.isEmpty()) {
							return
						}
						if (s.type !== 'ClassSelector' && s.type !== 'TypeSelector' && s.type !== 'IdSelector') {
							return
						}
						if (s.type === 'ClassSelector' && cleanCSSIdentifier(s.name) in nodes.classnames) {
							return
						}
						if (s.type === 'IdSelector' && cleanCSSIdentifier(s.name) in nodes.ids) {
							return
						}
						if (s.type === 'TypeSelector' && cleanCSSIdentifier(s.name) in nodes.typenames) {
							return
						}

						list.remove(item)
					})

					// We've removed all the selectors, need to remove entire rule
					if (list.isEmpty()) {
						parentList.remove(parentItem)
					}
				})
			}
		}
	})

	// Walk through all class selectors and increment their count
	// (Only if they are used, as we have already removed all unused classnames)
	cssTree.walk(ast, {
		visit: 'ClassSelector',
		enter: function (node) {
			const name = cleanCSSIdentifier(node.name)
			if (!(name in nodes.classnames)) {
				throw new Error('encountered unused class selector when it should have been removed')
			}

			nodes.classnames[name]++
		}
	})
	cssTree.walk(ast, {
		visit: 'IdSelector',
		enter: function (node) {
			const name = cleanCSSIdentifier(node.name)
			if (!(name in nodes.ids)) {
				throw new Error('encountered unused id selector when it should have been removed')
			}

			nodes.ids[name]++
		}
	})
}

function renameCSSNodes(names: Names, rename: Rename, ast: CSSNode): string {
	// TODO: refactor
	// For each selector in sorted order, walk through AST and rename each occurrence
	let i = 0
	for (const name of names.classnames) {
		cssTree.walk(ast, {
			visit: 'ClassSelector',
			enter: function (node) {
				const classname = cleanCSSIdentifier(node.name)
				if (name !== classname) {
					return
				}

				const newname = generateShortestName(i)
				rename.classnames[name] = newname
				node.name = newname
			}
		})
		i++
	}

	// TODO: refactor
	i = 0
	for (const name of names.ids) {
		cssTree.walk(ast, {
			visit: 'IdSelector',
			enter: function (node) {
				const id = cleanCSSIdentifier(node.name)
				if (name !== id) {
					return
				}

				const newname = generateShortestName(i)
				rename.ids[name] = newname
				node.name = newname
			}
		})
		i++
	}

	return cssTree.generate(ast)
}

function parseAndTrackHTMLNodes(nodes: Occurrences, data: string): HTMLNode {
	const ast = nodeHTMLParser(data, { script: true, style: true })
	parseHTMLNodeChildren(nodes, ast)
	return ast
}

function parseHTMLNodeChildren(nodes: Occurrences, node: HTMLNode): void {
	const element = node as HTMLElement
	if (element) {
		if (element.classNames) {
			// Count each className occurrence
			for (const className of element.classNames) {
				if (className in nodes.classnames) {
					nodes.classnames[className]++
					continue
				}

				nodes.classnames[className] = 1
			}
		}

		const id = element.id
		if (id) {
			if (id in nodes.ids) {
				nodes.ids[id]++
			} else {
				nodes.ids[id] = 1
			}
		}

		// Count each tagName occurrence
		const tagname = element.tagName
		if (tagname) {
			if (tagname in nodes.typenames) {
				nodes.typenames[tagname]++
			} else {
				nodes.typenames[tagname] = 1
			}
		}
	}

	for (const c of node.childNodes) {
		parseHTMLNodeChildren(nodes, c)
	}
}

function renameHTMLNodes(rename: Rename, node: HTMLNode) {
	const element = node as HTMLElement
	if (element) {
		// Rename classes
		if (element.classNames) {
			const replace = element.classNames.map(c => {
				if (c in rename.classnames) {
					return rename.classnames[c]
				}

				return c
			})

			if (replace.length > 0) {
				element.setAttribute('class', replace.join(' '))
			}
		}

		if (element.id) {
			let r = element.id
			if (element.id in rename.ids) {
				r = rename.ids[element.id]
			}
			element.setAttribute('id', r)
		}
	}

	for (const child of node.childNodes) {
		renameHTMLNodes(rename, child)
	}
}

function sortedNames(nodes: Occurrences): Names {
	let res: Names = {
		classnames: [],
		ids: [],
	}

	for (const [key, val] of Object.entries(nodes)) {
		const sorted = Object.entries(val)
			.map(([name, count]) => {
				return { name, total: name.length * count }
			})
			.sort((a, b) => b.total - a.total)
			.map(t => t.name)

		if (key === 'classnames') {
			res.classnames = sorted
		}
		if (key === 'ids') {
			res.ids = sorted
		}
	}

	return res
}

function cleanCSSIdentifier(n: string): string {
	return n.replace(/\\/g, '')
}

function generateShortestName(idx: number): string {
	function range(s: number, e: number) {
		let a = []
		for (let i = s; i < e; i++) {
			a.push(i)
		}
		return a
	}

	// Fill with a-z
	const ascii = range(97, 123).map(c => String.fromCharCode(c))

	let timesOver = 0
	while (idx >= ascii.length) {
		timesOver++

		idx -= ascii.length
	}

	if (timesOver) {
		return ascii[idx] + (timesOver - 1)
	}

	return ascii[idx]
}

function time(s: string): () => void {
	const start = process.hrtime()

	return function () {
		const end = process.hrtime(start)

		// If time is under a second, format like "340ms"
		let fmt = `${(end[1] / 1e6).toPrecision(3)}ms`
		if (end[0] > 0) {
			// Otherwise, format like "3.150s"
			fmt = `${end[0]}${(end[1] / 1e9).toPrecision(3).toString().slice(1)}s`
		}
		console.log(`${s} finished in ${fmt}`)
	}
}
time