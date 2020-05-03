const rip = require('./dist/rip').rip

describe('unused CSS removal', () => {
	const options = {
		uglify: false,
		removeUnusedCSS: true,
	}

	test('option is respected', () => {
		const html = ['<a> hi </a>']
		const css = ['h1 { padding: 4px; } .unused { padding: 4px; }']
		expect(ripData(html, css, { uglify: false, removeUnusedCSS: false })).toEqual(['<style>h1{padding:4px}.unused{padding:4px}</style><a> hi </a>'])
	})
	test('does not remove used type selectors', () => {
		const html = ['<a> hi </a>']
		const css = ['a { padding: 4px; }']
		expect(ripData(html, css, options)).toEqual(['<style>a{padding:4px}</style><a> hi </a>'])
	})
	test('does not remove used class selectors', () => {
		const html = ['<a class="used"> hi </a>']
		const css = ['.used { padding: 4px; }']
		expect(ripData(html, css, options)).toEqual(['<style>.used{padding:4px}</style><a class="used"> hi </a>'])
	})
	test('does not remove used id selectors', () => {
		const html = ['<a id="used"> hi </a>']
		const css = ['#used { padding: 4px; }']
		expect(ripData(html, css, options)).toEqual(['<style>#used{padding:4px}</style><a id="used"> hi </a>'])
	})
	test('removes unused type selectors', () => {
		const html = ['<a> hi </a>']
		const css = ['h1 { padding: 4px; }']
		expect(ripData(html, css, options)).toEqual(['<style></style><a> hi </a>'])
	})
	test('removes unused class selectors', () => {
		const html = ['<a> hi </a>']
		const css = ['.unused { padding: 4px; }']
		expect(ripData(html, css, options)).toEqual(['<style></style><a> hi </a>'])
	})
	test('removes unused id selectors', () => {
		const html = ['<a> hi </a>']
		const css = ['#unused { padding: 4px; }']
		expect(ripData(html, css, options)).toEqual(['<style></style><a> hi </a>'])
	})
})

// Wraps each entry in a File object, then returns only the data from the ripped results.
// Also wraps html data in body tags and removes body tags from results
function ripData(htmlData, cssData, options) {
	const htmlFiles = htmlData.map(d => { return { path: 'empty path', data: `<body>${d}</body>` } })
	const cssFiles = cssData.map(d => { return { path: 'empty path', data: d } })
	return rip(htmlFiles, cssFiles, options).map(r => r.data.slice(6, -7))
}