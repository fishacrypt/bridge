// Patches deployments.json into the dapp's BRIDGE config block (between the BRIDGE_CONFIG markers).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

function apply(htmlPath = path.join(root, process.env.DAPP_FILE || 'dapp/tetrix-bridge.html'), depPath = path.join(root, 'deployments.json')) {
  const d = JSON.parse(fs.readFileSync(depPath, 'utf8'));
  const spokes = {};
  for (const [id, c] of Object.entries(d.chains)) if (c.role === 'spoke') spokes[id] = { bridge: c.bridge, token: c.token };
  const hub = d.chains[d.hubChainId];
  const cfg = { hub: { address: hub.bridge, wqms: d.wqms }, spokes };
  let s = fs.readFileSync(htmlPath, 'utf8');
  const re = /\/\* BRIDGE_CONFIG_START \*\/[\s\S]*?\/\* BRIDGE_CONFIG_END \*\//;
  if (!re.test(s)) throw new Error('BRIDGE_CONFIG markers not found in ' + htmlPath);
  s = s.replace(re, () => '/* BRIDGE_CONFIG_START */const BRIDGE=' + JSON.stringify(cfg) + ';/* BRIDGE_CONFIG_END */');
  fs.writeFileSync(htmlPath, s);
  console.log('Patched dapp config in', path.relative(root, htmlPath));
}
module.exports = { apply };
if (require.main === module) apply();
