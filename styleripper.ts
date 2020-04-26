import cssTree, { CssNode as CSSNode } from 'css-tree'
import nodeHTMLParser, { Node as HTMLNode, HTMLElement } from 'node-html-parser'
import { File } from './build'

type Options = {
	mode: Mode
}

export const MODES = ['inlineCSS', 'externalCSS'] as const
export type Mode = (typeof MODES)[number] // Union type

type ParsedFile = {
	file: File
	ast: CSSNode | HTMLNode
}

type NodeOccurrences = {
	[index: string]: number
}

export type RipInlineCSSResult = HTMLWithInlineCSSFile[]

type HTMLWithInlineCSSFile = {
	path: string
	data: string
	css: string
}

export type RipExternalCSSResult = {
	htmlFiles: File[]
	cssFiles: File[]
}

export function rip(htmlFiles: File[], cssFiles: File[], options: Options): RipInlineCSSResult | RipExternalCSSResult {
	switch (options.mode) {
		case 'inlineCSS':
			return ripInlineCSS(htmlFiles, cssFiles)
		case 'externalCSS':
			return ripExternalCSS(htmlFiles, cssFiles)
	}
}

// TODO: documentation
function ripInlineCSS(htmlFiles: File[], cssFiles: File[]): RipInlineCSSResult {
	return htmlFiles.map(html => {
		// Determine total node usage for this (HTML; CSS...) pair
		let nodes: NodeOccurrences = {}

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
		let rename: { [index: string]: string } = {}

		// CSS nodes are renamed and remembered in `rename`, and the resulting CSS is returned
		// In "InlineCSS" mode each HTML file gets its own bundle of CSS, so we concat the results
		const inlineCSS: string = pcssFiles.map(pcss => {
			return {
				path: pcss.file.path,
				data: renameCSSNodes(names, rename, (pcss.ast as CSSNode))
			}
		}).reduce((acc, css) => css.data + acc, '')

		// Rewrite all nodes according to `rename`
		renameHTMLNodes(rename, ast)

		return {
			path: html.path,
			data: ast.toString(),
			css: inlineCSS,
		}
	})
}

function ripExternalCSS(htmlFiles: File[], cssFiles: File[]): RipExternalCSSResult {
	// nodes contains information about the class name nodes appearing in all input files
	const nodes: NodeOccurrences = {}

	// renames contains information describing which nodes to rename to what
	const rename: { [index: string]: string } = {}

	const phtmlFiles: ParsedFile[] = htmlFiles.map(html => {
		// Parse HTML into an AST, incrementing each occurrence of every renameable node.
		// Save AST on object to reuse later when renaming each node
		const ast = parseAndTrackHTMLNodes(nodes, html.data)
		return { file: html, ast }
	})

	const pcssFiles: ParsedFile[] = cssFiles.map(css => {
		// Remove unused nodes, then increment each node occurrence
		const ast = parseAndTrackCSSNodes(nodes, css.data)
		return { file: css, ast }
	})

	// Calculate the total byte size of each classname (count * name length) and collect it into an array so we can sort it
	let sorted = sortedNames(nodes)

	// Afterwards, nodes are renamed and recorded in `rename`, and the resulting CSS is returned
	const rippedCSS: File[] = pcssFiles.map(pcss => {
		return {
			path: pcss.file.path,
			data: renameCSSNodes(sorted, rename, (pcss.ast as CSSNode))
		}
	})

	// Go through HTML files again, and rewrite all nodes according to `rename`
	const rippedHTML: File[] = phtmlFiles.map(phtml => {
		renameHTMLNodes(rename, (phtml.ast as HTMLNode))
		return {
			path: phtml.file.path,
			data: phtml.ast.toString(),
		}
	})

	return {
		htmlFiles: rippedHTML,
		cssFiles: rippedCSS,
	}
}

function parseAndTrackCSSNodes(nodes: NodeOccurrences, data: string): CSSNode {
	// Parse given CSS file into an AST
	const ast = cssTree.parse(data)

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
					if (s.type !== 'ClassSelector' || list.isEmpty() || cleanCSSIdentifier(s.name) in nodes) {
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
			if (!(name in nodes)) {
				throw new Error('encountered unused class selector when it should have been removed')
			}

			nodes[name]++
		}
	})

	return ast
}

function renameCSSNodes(classnames: string[], rename: { [index: string]: string }, ast: CSSNode): string {
	// For each selector in sorted order, walk through AST and rename each occurrence
	let i = 0
	for (const classname of classnames) {
		cssTree.walk(ast, {
			visit: 'ClassSelector',
			enter: function (node) {
				const name = cleanCSSIdentifier(node.name)
				if (classname !== name) {
					return
				}

				const newname = generateShortestName(i)
				rename[name] = newname
				node.name = newname
			}
		})
		i++
	}

	return cssTree.generate(ast)
}

function parseAndTrackHTMLNodes(nodes: NodeOccurrences, data: string): HTMLNode {
	const ast = nodeHTMLParser(data, { script: true, style: true })
	parseHTMLNodeChildren(nodes, ast)
	return ast
}

function parseHTMLNodeChildren(nodes: NodeOccurrences, node: HTMLNode): void {
	const element = node as HTMLElement
	if (element) {
		// Count each className occurrence
		if (element.classNames) {
			for (const className of element.classNames) {
				if (className in nodes) {
					nodes[className]++
					continue
				}
				nodes[className] = 1
			}
		}
	}

	for (const child of node.childNodes) {
		parseHTMLNodeChildren(nodes, child)
	}
}

function renameHTMLNodes(rename: { [index: string]: string }, node: HTMLNode) {
	const element = node as HTMLElement
	if (element) {
		// Rename classes
		if (element.classNames) {
			const replace = element.classNames.map(c => {
				if (c in rename) {
					return rename[c]
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

function sortedNames(nodes: NodeOccurrences): string[] {
	return Object.entries(nodes)
		.map(([name, count]) => {
			return { name, total: name.length * count }
		})
		.sort((a, b) => b.total - a.total)
		.map(t => t.name)
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