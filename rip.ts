import cssTree, { CssNode as CSSNode, List as CSSList, ListItem as CSSListItem } from 'css-tree'
import { Node as HTMLNode, HTMLElement } from 'node-html-parser'
import { walkHTML, HTMLFile, CSSFile } from './build'

type Options = {
	// "uglify" specifies if nodes should be renamed (class and id names)
	uglify: boolean
	// "removeUnusedCSS" specifies if unused CSS rules should be removed
	removeUnusedCSS: boolean
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

export function rip(htmlFiles: HTMLFile[], cssFiles: CSSFile[], options: Options): HTMLFile[] {
	const ripped = htmlFiles.map(html => {
		// Determine total node usage for this (HTML; CSS...) pair
		let nodes: Occurrences = {
			classnames: {},
			typenames: {},
			ids: {},
		}

		processHTMLNodes(nodes, html.root)

		const clonedCSS = cssFiles.map(css => {
			return {
				file: css.file,
				root: cssTree.clone(css.root),
			}
		})

		clonedCSS.forEach(css => {
			// Remove unused nodes
			if (options.removeUnusedCSS) {
				removeUnusedCSS(css.root, nodes)
			}

			// Increment each node occurrence
			processCSSNodes(css.root, nodes)
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
			let data = undefined
			if (options.uglify) {
				data = renameCSSNodes(names, rename, (pcss.root as CSSNode))
			} else {
				data = cssTree.generate(pcss.root as CSSNode)
			}
			return {
				path: pcss.file.path,
				data,
			}
		}).reduce((acc, css) => css.data + acc, '')

		if (options.uglify) {
			// Rewrite all nodes according to `rename`
			renameHTMLNodes(rename, html.root)
		}

		let data = html.root.toString()
		// Insert right where <body> starts
		data = data.replace('<body>', `<body><style>${inlineCSS}</style>`)
		return {
			file: {
				path: html.file.path,
				data,
			},
			root: html.root,
		}
	})
	return ripped
}

function processCSSNodes(ast: CSSNode, nodes: Occurrences): void {
	// Walk through all class selectors and increment their count
	// (Only if they are used, as we should have already removed all unused classnames, if necessary)
	// TODO: figure out what to use instead of "any"
	const incrementOccurrences = (selectorType: any, occ: NodeOccurrences) => {
		cssTree.walk(ast, {
			visit: selectorType,
			enter: function (node: any) {
				const name = cleanCSSIdentifier(node.name)
				// Only count nodes that are actually present in the HTML
				if (name in occ) {
					occ[name]++
				}
			}
		})
	}

	incrementOccurrences('ClassSelector', nodes.classnames)
	incrementOccurrences('IdSelector', nodes.ids)
}

function removeUnusedCSS(ast: CSSNode, nodes: Occurrences) {
	// Walk AST and remove rules in which all selectors are unused
	cssTree.walk(ast, {
		enter: function (node: CSSNode, parentItem: CSSListItem<CSSNode>, parentList: CSSList<CSSNode>) {
			// Remove comments
			if (node.type == 'Comment') {
				parentList.remove(parentItem)
				return
			}

			if (node.type == 'Rule') {
				const selectorList = node.prelude as cssTree.SelectorList
				if (!selectorList) {
					return
				}

				removeUnusedSelectors(nodes, selectorList, () => parentList.remove(parentItem))
			}
		}
	})
}

function removeUnusedSelectors(nodes: Occurrences, selectorList: cssTree.SelectorList, removeRule: () => void) {
	// Never remove these special type selectors
	const typeSelectorWhitelist = ['*', 'html']

	// Remove any unused class selectors from SelectorList
	selectorList.children.each((node, item, list) => {
		const selector = node as cssTree.Selector
		selector.children.each((node) => {
			if (list.isEmpty()) {
				return
			}
			if (node.type !== 'ClassSelector'
				&& node.type !== 'TypeSelector'
				&& node.type !== 'IdSelector') {
				return
			}

			const name = cleanCSSIdentifier(node.name)
			switch (node.type) {
				case 'ClassSelector':
					if (name in nodes.classnames) {
						return
					}
					break
				case 'IdSelector':
					if (name in nodes.ids) {
						return
					}
					break
				case 'TypeSelector':
					if (name in nodes.typenames || typeSelectorWhitelist.includes(name)) {
						return
					}
			}

			list.remove(item)
		})

		// We've removed all the selectors, need to remove entire rule
		if (list.isEmpty()) {
			removeRule()
		}
	})
}

function renameCSSNodes(names: Names, rename: Rename, ast: CSSNode): string {
	// For each selector in sorted order, walk through AST and rename each occurrence
	// TODO: figure out how to not use "any"
	const renameSelector = (selectorType: any, selectorNames: string[], selectorRename: { [index: string]: string }) => {
		let i = 0
		for (const name of selectorNames) {
			cssTree.walk(ast, {
				visit: selectorType,
				// TODO: figure out how to not use "any"
				enter: function (node: any) {
					const selName = cleanCSSIdentifier(node.name)
					if (name !== selName) {
						return
					}

					const newname = generateShortestName(i)
					selectorRename[name] = newname
					node.name = newname
				}
			})
			i++
		}
	}

	renameSelector('ClassSelector', names.classnames, rename.classnames)
	renameSelector('IdSelector', names.ids, rename.ids)

	return cssTree.generate(ast)
}

// Walk HTML AST, incrementing each occurrence of every renameable node.
function processHTMLNodes(nodes: Occurrences, node: HTMLNode): void {
	walkHTML(node, (el: HTMLElement) => {
		processHTMLElement(nodes, el)
	})
}

function processHTMLElement(nodes: Occurrences, el: HTMLElement) {
	if (el.classNames) {
		// Count each className occurrence
		for (const className of el.classNames) {
			if (className in nodes.classnames) {
				nodes.classnames[className]++
				continue
			}

			nodes.classnames[className] = 1
		}
	}

	const id = el.id
	if (id) {
		if (id in nodes.ids) {
			nodes.ids[id]++
		} else {
			nodes.ids[id] = 1
		}
	}

	// Count each tagName occurrence
	const tag = el.tagName
	if (tag) {
		if (tag in nodes.typenames) {
			nodes.typenames[tag]++
		} else {
			nodes.typenames[tag] = 1
		}
	}
}

function renameHTMLNodes(rename: Rename, node: HTMLNode) {
	walkHTML(node, (el: HTMLElement) => {
		renameHTMLElement(rename, el)
	})
}

function renameHTMLElement(rename: Rename, el: HTMLElement) {
	// Rename classes
	if (el.classNames) {
		const replace = el.classNames.map(c => {
			if (c in rename.classnames) {
				return rename.classnames[c]
			}

			return c
		})

		if (replace.length > 0) {
			el.setAttribute('class', replace.join(' '))
		}
	}

	// Rename ID
	if (el.id) {
		let id = el.id
		if (el.id in rename.ids) {
			id = rename.ids[el.id]
		}
		el.setAttribute('id', id)
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
