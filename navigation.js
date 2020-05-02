var r = {}
var req = new XMLHttpRequest();
req.addEventListener('load', function(){
	var nr = JSON.parse(this.responseText)
	for (var key in nr) {
		r[key] = nr[key]
	}
})
req.open('GET', "/_til/nav"+location.pathname+'routes.json')
req.send()
var html = document.querySelector('html')
function d() {
	document.querySelectorAll('a[href]').forEach(function(e) { e.onclick = g })
}
function g(e) {
	var t = e.target.closest('a[href]')
	var p = typeof e == 'object' ? t.getAttribute('href') : e
	if (!(p in r)) {
		console.error('route does not exist:', p)
		return false
	}
	html.innerHTML = r[p]
	history.pushState({}, '', p)
	d()
	return false
}
window.onpopstate = function() {
	g(location.pathname)
}
d()
r[location.pathname] = html.innerHTML