#!/usr/bin/env node
import til, { task } from './build'
import browserSync from 'browser-sync'
const bs = browserSync.create()

const PROD = process.env.PROD == undefined ? true : process.env.PROD == 'true'

const build = async (prod: boolean) => {
	const prodStr = prod ? 'production' : 'development'
	await task(`building for ${prodStr}`, true, async () => {
		await til.build({
			configPath: './tilrc.json',
			prod,
		})
	})
}

const cmd = process.argv[2]; // semicolon necessary
(async () => {
	switch (cmd) {
		case undefined:
		case 'build':
			await build(PROD)
			break

		case 'dev':
			bs.init({
				server: './dist',
				ui: false,
				notify: false,
				open: false,
				logPrefix: '',
			}, async () => {
				// Initial build
				await build(false)
				bs.reload(['*.html'])

				til.watch(async file => {
					// Development build
					await build(false)
					const reload = file.endsWith('.css') ? ['*.css'] : ['*.html', '*.css']
					bs.reload(reload)
				})
			})
			break
	}
})()