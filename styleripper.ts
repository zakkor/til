import cssTree, { CssNode as CSSNode } from 'css-tree'
import nodeHTMLParser, { Node as HTMLNode, HTMLElement } from 'node-html-parser'
import { File } from './build'

type Options = {
	minify: boolean
}

type ParsedFile = {
	file: File
	ast: CSSNode | HTMLNode
}

type Occurrences = {
	[index: string]:
	NodeOccurrences
}

type NodeOccurrences = {
	[index: string]: number
}

// Mapping of which nodes were renamed from initial name to new name, for each node type.
// example: rename.classnames['col-lg-6'] // is 'b'
type Rename = {
	[index: string]: { [index: string]: string }
}

export function rip(htmlFiles: File[], cssFiles: File[], options: Options): File[] {
	return htmlFiles.map(html => {
		// Determine total node usage for this (HTML; CSS...) pair
		let nodes: Occurrences = {
			classnames: {}
		}

		// Parse HTML into an AST, incrementing each occurrence of every renameable node.
		// Save AST on object to reuse later when renaming each node
		const ast = parseAndTrackHTMLNodes(nodes, html.data)

		const pcssFiles: ParsedFile[] = cssFiles.map(css => {
			// Remove unused nodes, then increment each node occurrence
			const ast = parseAndTrackCSSNodes(nodes, css.data)
			return { file: css, ast }
		})

		// Calculate the total byte size of each node (n.count * n.name.length) and collect it into a sorted array
		let names = sortedNames(nodes)

		// Start keeping track of how we've renamed nodes for this HTML file
		let rename: Rename = {
			classnames: {},
		}

		// CSS nodes are renamed and remembered in `rename`, and the resulting CSS is returned
		// Each HTML file gets its own bundle of CSS, so we concat the results
		const inlineCSS: string = pcssFiles.map(pcss => {
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

		return {
			path: html.path,
			data: `<style>${inlineCSS}</style>` + ast.toString(),
		}
	})
}

function parseAndTrackCSSNodes(nodes: Occurrences, data: string): CSSNode {
	// Parse given CSS file into an AST
	const ast = cssTree.parse(data)

	// Remove comments
	cssTree.walk(ast, {
		visit: 'Comment',
		enter: function (_, item, list) {
			list.remove(item)
		},
	})

	// Walk AST and remove rules in which the only selector is an unused class
	cssTree.walk(ast, {
		visit: 'Rule',
		enter: function (node, parentItem, parentList) {
			if (!(node.prelude as cssTree.SelectorList)) {
				return
			}

			(node.prelude as cssTree.SelectorList).children.each((selector, item, list) => {
				// Remove any unused class selectors from SelectorList
				(selector as cssTree.Selector).children.each((s) => {
					if (s.type !== 'ClassSelector' || list.isEmpty() || cleanCSSIdentifier(s.name) in nodes.classnames) {
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

	return ast
}

function renameCSSNodes(names: { [index: string]: string[] }, rename: Rename, ast: CSSNode): string {
	// For each selector in sorted order, walk through AST and rename each occurrence
	let i = 0
	for (const classname of names.classnames) {
		cssTree.walk(ast, {
			visit: 'ClassSelector',
			enter: function (node) {
				const name = cleanCSSIdentifier(node.name)
				if (classname !== name) {
					return
				}

				const newname = generateShortestName(i)
				rename.classnames[name] = newname
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
		// Count each className occurrence
		if (element.classNames) {
			for (const className of element.classNames) {
				if (className in nodes.classnames) {
					nodes.classnames[className]++
					continue
				}
				nodes.classnames[className] = 1
			}
		}
	}

	for (const child of node.childNodes) {
		parseHTMLNodeChildren(nodes, child)
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
	}

	for (const child of node.childNodes) {
		renameHTMLNodes(rename, child)
	}
}

function sortedNames(nodes: Occurrences): { [index: string]: string[] } {
	let res: { [index: string]: string[] } = {}

	for (const [key, val] of Object.entries(nodes)) {
		res[key] = Object.entries(val)
			.map(([name, count]) => {
				return { name, total: name.length * count }
			})
			.sort((a, b) => b.total - a.total)
			.map(t => t.name)
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