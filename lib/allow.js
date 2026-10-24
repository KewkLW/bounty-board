// allow_cidrs: only these addresses may connect (boards and the hub share the model).
const net = require('net');

function allowList(cidrs) {
  const bl = new net.BlockList();
  for (const c of cidrs || []) {
    const [addr, bits] = c.split('/');
    bl.addSubnet(addr, Number(bits), addr.includes(':') ? 'ipv6' : 'ipv4');
  }
  return ip => {
    if (!ip) return false;
    const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    return bl.check(v4, v4.includes(':') ? 'ipv6' : 'ipv4');
  };
}

module.exports = { allowList };
