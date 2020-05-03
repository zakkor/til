const rip = require('./dist/rip').rip

describe('unused CSS removal', () => {
	const options = {
		uglify: false,
		removeUnusedCSS: true,
	}

	test('option is respected', () => {
		const html = ['<a> hi </a>']
		const css = ['h1 {} .unused {}']
		expect(ripData(html, css, { uglify: false, removeUnusedCSS: false })).toEqual(['<style>h1{}.unused{}</style><a> hi </a>'])
	})
	test('does not remove used type selectors', () => {
		const html = ['<a> hi </a>']
		const css = ['a {}']
		expect(ripData(html, css, options)).toEqual(['<style>a{}</style><a> hi </a>'])
	})
	test('does not remove used class selectors', () => {
		const html = ['<a class="used"> hi </a>']
		const css = ['.used {}']
		expect(ripData(html, css, options)).toEqual(['<style>.used{}</style><a class="used"> hi </a>'])
	})
	test('does not remove used id selectors', () => {
		const html = ['<a id="used"> hi </a>']
		const css = ['#used {}']
		expect(ripData(html, css, options)).toEqual(['<style>#used{}</style><a id="used"> hi </a>'])
	})

	test('does not remove attribute selectors', () => {
		const html = ['<a> hi </a>']
		const css = ['[type="checkbox"],[type="radio"]{}']
		expect(ripData(html, css, options)).toEqual(['<style>[type="checkbox"],[type="radio"]{}</style><a> hi </a>'])
	})
	test('does not remove "*" selector', () => {
		const html = ['<a> hi </a>']
		const css = ['*{}']
		expect(ripData(html, css, options)).toEqual(['<style>*{}</style><a> hi </a>'])
	})
	test('does not remove "html" selector', () => {
		const html = ['']
		const css = ['html{}']
		expect(ripData(html, css, options)).toEqual(['<style>html{}</style>'])
	})
	test('does not remove "body" selector', () => {
		const html = ['']
		const css = ['body{}']
		expect(ripData(html, css, options)).toEqual(['<style>body{}</style>'])
	})
	test('does not remove used media queries', () => {
		const html = ['<a class="used"></a>']
		const css = ['@media (min-width: 640px) { .used{} }']
		expect(ripData(html, css, options)).toEqual(['<style>@media (min-width:640px){.used{}}</style><a class="used"></a>'])
	})
	
	// TODO: fix
	test('removes unused attribute selectors', () => {
		const html = ['']
		const css = ['[hidden]{}']
		expect(ripData(html, css, options)).toEqual(['<style></style>'])
	})
	// TODO: fix
	test('removes empty media queries', () => {
		const html = ['']
		const css = ['@media (min-width: 640px) { }']
		expect(ripData(html, css, options)).toEqual(['<style></style>'])
	})
	// TODO: fix
	test('removes media queries made empty after rule removal', () => {
		const html = ['']
		const css = ['@media (min-width: 640px) { .unused {} }']
		expect(ripData(html, css, options)).toEqual(['<style></style>'])
	})
	test('removes unused type selectors', () => {
		const html = ['<a> hi </a>']
		const css = ['h1 {}']
		expect(ripData(html, css, options)).toEqual(['<style></style><a> hi </a>'])
	})
	test('removes unused class selectors', () => {
		const html = ['<a> hi </a>']
		const css = ['.unused {}']
		expect(ripData(html, css, options)).toEqual(['<style></style><a> hi </a>'])
	})
	test('removes unused id selectors', () => {
		const html = ['<a> hi </a>']
		const css = ['#unused {}']
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