const fs = require('fs')
const csstree = require('css-tree')
const htmlparse = require('node-html-parser')
const R = require('ramda')

// a list of .js and .html files
const inputFiles = process.argv.slice(2)

// number of times each class name appears
const classNodes = {}

for (const file of inputFiles) {
  if (!file.endsWith('.html')) {
    continue
  }

  const contents = fs.readFileSync(file, 'utf8')
  parseHTML(classNodes, contents)
}

for (const file of inputFiles) {
  if (!file.endsWith('.css')) {
    continue
  }

  const contents = fs.readFileSync(file, 'utf8')
  parseCSS(classNodes, contents)
}

function parseCSS(classNodes, content) {
  const ast = csstree.parse(content)

  csstree.walk(ast, function (node) {
    if (node.type === 'ClassSelector') {
      if (node.name in classNodes) {
        classNodes[node.name].count++
      }
      // else {
      //   classNodes[node.name] = {
      //     count: 1,
      //   }
      // }
    }
  })

  const biggestNodes = []
  for (const [name, node] of Object.entries(classNodes)) {
    const val = node.count * name.length

    biggestNodes.push({ name, total: val })
  }


  const nodeComparator = function (a, b) {
    return b.total - a.total
  }
  biggestNodes.sort(nodeComparator)

  console.log('sorted:', biggestNodes)

  // remove unused classes
  csstree.walk(ast, {
    visit: 'Rule',
    enter: function (node, item, list) {
      let found = false
      for (const [name] of Object.entries(classNodes)) {
        const hasClass = csstree.find(node.prelude, node =>
          node.type === 'ClassSelector' && node.name === name
        );
        if (hasClass) {
          found = true
          break
        }
      }
      if (!found) {
        console.log('removed', node.prelude)
        list.remove(item)
      }
      

      // if (!(node.prelude.value in classNodes) && list) {
      // }
    }
  })
    

  let idx = 0
  for (const bigNode of biggestNodes) {
    csstree.walk(ast, function (node) {
      if (node.type !== 'ClassSelector') {
        return
      }

      if (node.name == bigNode.name) {
        console.log('renamed from ', node.name)
        node.name = generateShortestName(idx)
        console.log('renamed to', node.name)
      }
    })
    idx++
  }

  const generatedCSS = csstree.generate(ast)
  console.log('length:', generatedCSS.length)
  fs.writeFileSync('test/output.css', generatedCSS)
}

function parseHTML(classNodes, contents) {
  const el = htmlparse.parse(contents)
  addNodeChildren(classNodes, el)
}

function addNodeChildren(classNodes, el) {
  for (const child of el.childNodes) {
    if (child.classNames != undefined) {
      for (const className of child.classNames) {
        if (className in classNodes) {
          classNodes[className].count++
        } else {
          classNodes[className] = {
            count: 1,
          }
        }
      }
    }

    if (child.childNodes.length > 0) {
      addNodeChildren(classNodes, child)
    }
  }
}

function generateShortestName(idx) {
  // fill with a-z
  const letters =
    R.range(97, 123)
      .map(c => String.fromCharCode(c))

  let timesOver = 0
  while (idx >= letters.length) {
    timesOver++

    idx -= letters.length
  }

  if (timesOver) {
    return letters[idx] + (timesOver - 1)
  }

  return letters[idx]
}