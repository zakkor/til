#!/usr/bin/env node
import til from './build'
import browserSync from 'browser-sync'
const bs = browserSync.create()

const PROD = process.env.PROD == undefined ? true : process.env.PROD == 'true'

const build = (prod: boolean) => {
	const start = process.hrtime()
	til.build({
		configPath: './tilrc.json',
		prod,
	})
	const end = process.hrtime(start)

	// If time is under a second, format like "340ms"
	let fmt = `${(end[1] / 1e6).toPrecision(3)}ms`
	if (end[0] > 0) {
		// Otherwise, format like "3.150s"
		fmt = `${end[0]}${(end[1] / 1e9).toPrecision(3).toString().slice(1)}s`
	}
	console.log(`build finished in ${fmt}`)
}

// Watch
if (process.argv.includes('dev')) {
	bs.init({
		server: './dist',
		ui: false,
		notify: false,
		open: false,
		logPrefix: '',
	})

	// Initial build
	build(false)
	bs.reload(['*.html'])

	til.watch(file => {
		// Development build
		build(false)
		const reload = file.endsWith('.css') ? ['*.css'] : ['*.html', '*.css']
		bs.reload(reload)
	})
} else {
	build(PROD)
}