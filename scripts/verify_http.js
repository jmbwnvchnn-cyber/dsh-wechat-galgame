'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let callback;
Module._load = function(request, parent, isMain) {
  if (request === 'node:http') return { createServer(fn) { callback = fn; return { listen() {}, on() {} }; } };
  return originalLoad.call(this, request, parent, isMain);
};
require('../server');
Module._load = originalLoad;
function request(url) {
  let result;
  callback({ url, method: 'GET', headers: { host: '127.0.0.1:3000' } }, { writeHead(status) { result = status; }, end() {} });
  return result;
}
assert.equal(request('//'), 400);
assert.equal(request('/api/health'), 200);
console.log('HTTP malformed target rejected; health request succeeds.');
