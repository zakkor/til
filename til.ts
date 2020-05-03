#!/usr/bin/env node
import til, { task } from './build'
import browserSync from 'browser-sync'
const bs = browserSync.create()

const PROD = process.env.PROD == undefined ? true : process.env.PROD == 'true'

const build = (prod: boolean) => {
	const prodStr = prod ? 'production' : 'development'
	task(`building for ${prodStr}`, true, () => {
		til.build({
			configPath: './tilrc.json',
			prod,
		})
	})
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