// Compiles contracts/ with solc-js (no network access needed). Output: build/<Name>.json {abi, bytecode}
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const root = path.join(__dirname, '..');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.sol') ? [path.join(dir, e.name)] : []);
}
const sources = {};
for (const f of walk(path.join(root, 'contracts'))) sources[path.relative(root, f).replace(/\\/g, '/')] = { content: fs.readFileSync(f, 'utf8') };

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris', // no PUSH0: safest for chains whose EVM version we don't control
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
  }
};
function findImports(p) {
  for (const base of [root, path.join(root, 'node_modules')]) {
    const f = path.join(base, p);
    if (fs.existsSync(f)) return { contents: fs.readFileSync(f, 'utf8') };
  }
  return { error: 'not found: ' + p };
}
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
let failed = false;
for (const e of out.errors || []) {
  if (e.severity === 'error') { failed = true; console.error(e.formattedMessage); }
  else if (!/SPDX|Unused|visibility/.test(e.message)) console.warn(e.formattedMessage);
}
if (failed) process.exit(1);
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
for (const file of Object.keys(out.contracts)) {
  if (!file.startsWith('contracts/')) continue;
  for (const [name, c] of Object.entries(out.contracts[file])) {
    fs.writeFileSync(path.join(root, 'build', name + '.json'),
      JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 1));
    console.log('compiled', name, (c.evm.bytecode.object.length / 2) + ' bytes');
  }
}
