import fs from 'fs'
import filepath from 'path'
import zlib from 'zlib'
import { CompressKinds } from './config'

export type File = {
	path: string
	data: string
}

type WatchFn = (path: string) => void

type WalkFn = (path: string, isDir: boolean) => void
type AsyncWalkFn = (path: string, isDir: boolean) => Promise<void>

export function watch(fn: WatchFn) {
	const watcher = (file: string) => {
		let wtimeout: NodeJS.Timeout | null
		// Debounce
		return () => {
			if (wtimeout == null) {
				// If we don't wait a bit before running the function, some files may not be fully written
				setTimeout(() => {
					fn(file)
				}, 100)
				wtimeout = setTimeout(() => { wtimeout = null }, 200)
			}
		}
	}

	const paths = collect(['./pages', './components', './styles', './styles'],
		['.html', '.css', '.js', '.svg', '.png', '.jpg'])

	for (const p of paths) {
		fs.watch(p, {}, watcher(p))
	}
}

export function collectFiles(paths: string[], extensions: string[]): File[] {
	return collect(paths, extensions).map(f => { return { path: f, data: fs.readFileSync(f, 'utf8') } })
}

export function collect(paths: string[], extensions: string[]): string[] {
	let files: string[] = []
	for (const path of paths) {
		walk(path, (path: string, isDir: boolean) => {
			if (isDir) {
				return
			}

			let ok = false
			for (const ext of extensions) {
				if (path.endsWith(ext)) {
					ok = true
					break
				}
			}
			if (!ok) {
				return
			}

			files.push(path)
		})
	}

	return files
}

export function walk(path: string, fn: WalkFn): void {
	let dir: fs.Dir
	try {
		dir = fs.opendirSync(path)
	} catch {
		// Doesn't exist
		return
	}

	let dirent: fs.Dirent
	while (dirent = dir.readSync()) {
		if (dirent === null) {
			break
		}

		const full = filepath.join(path, dirent.name)
		if (dirent.isDirectory()) {
			walk(full, fn)
			fn(full, true) // is dir
		} else {
			fn(full, false) // is not dir
		}
	}
	dir.closeSync()
}

export function walktopSync(path: string, fn: WalkFn): void {
	const dir = fs.opendirSync(path)
	let dirent = null
	while (dirent = dir.readSync()) {
		if (dirent === null) {
			break
		}

		const full = filepath.join(path, dirent.name)
		fn(full, dirent.isDirectory())
	}
	dir.closeSync()
}

export async function walktop(path: string, fn: AsyncWalkFn): Promise<void> {
	const dir = fs.opendirSync(path)
	let dirent = null
	while (dirent = dir.readSync()) {
		if (dirent === null) {
			break
		}

		const full = filepath.join(path, dirent.name)
		await fn(full, dirent.isDirectory())
	}
	dir.closeSync()
}

export function writeFileCompressed(path: string, data: string, compress: CompressKinds): void {
	if (compress === 'brotli') {
		fs.writeFileSync(`${path}.br`, zlib.brotliCompressSync(data))
		return
	}
	if (compress === 'gzip') {
		fs.writeFileSync(`${path}.gz`, zlib.gzipSync(data))
		return
	}

	fs.writeFileSync(path, data)
}
