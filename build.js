const fs = require('fs')
const path = require('path')

function walk(d, fn) {
  const dir = fs.opendirSync(d)

  let dirent = null
  while (dirent = dir.readSync()) {
    if (dirent === null) {
      break
    }

    const full = path.join(d, dirent.name)
    if (dirent.isDirectory()) {
      walk(full, fn)
    } else {
      fn(full)
    }
  }
}

fs.mkdir('./dist', async () => {
  let routes = {}

  walk('./src', file => {
    const buf = fs.readFileSync(file)
    const r = file.replace(/.+?\//, '/').replace(/\/index.html$/, '/')
    routes[r] = buf.toString()
  })

  routes = JSON.stringify(routes)
  fs.writeFileSync('./dist/index.html', `<script> const r = ${routes} </script>`)
})
