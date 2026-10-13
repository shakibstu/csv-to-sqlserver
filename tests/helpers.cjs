const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');

function loadSource(relativePath, mocks = {}) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const nativeRequire = createRequire(filename);
    const requireModule = (name) => {
      if (Object.prototype.hasOwnProperty.call(mocks, name)) return mocks[name];
      if (name.startsWith('.')) {
        const resolved = path.resolve(path.dirname(filename), name);
        if (fs.existsSync(resolved + '.ts')) return load(resolved + '.ts');
      }
      return nativeRequire(name);
    };
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    const wrapper = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename });
    wrapper(requireModule, module, module.exports, filename, path.dirname(filename));
    return module.exports;
  }
  return load(path.resolve(__dirname, '..', relativePath));
}

module.exports = { loadSource };
