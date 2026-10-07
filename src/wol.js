import dgram from 'node:dgram';
import os from 'node:os';

/**
 * Build a magic packet: 6x 0xFF followed by the target MAC repeated 16 times.
 */
export function buildMagicPacket(mac) {
  const hex = mac.trim().replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) {
    throw new Error(`Invalid MAC address: ${mac}`);
  }
  const macBytes = Buffer.from(hex.match(/../g).map((b) => parseInt(b, 16)));
  const packet = Buffer.alloc(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    macBytes.copy(packet, 6 + i * 6);
  }
  return packet;
}

/**
 * Every address we try. Broadcast plus a subnet-directed broadcast and a
 * unicast, because some switches and APs drop global broadcast on wifi.
 */
// Virtual interfaces would only send the packet to docker/VM subnets that
// have no WoL listener on them.
const VIRTUAL_IFACE = /^(docker|br-|virbr|veth|lo$|tun|tap|wg)/;

function destinations(extraBroadcast) {
  const list = [{ address: '255.255.255.255', port: 9 }];
  if (extraBroadcast) list.push({ address: extraBroadcast, port: 9 });

  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ip = entry.address.split('.').map(Number);
      list.push({ address: ip.slice(0, 3).join('.') + '.255', port: 9 });
      list.push({ address: entry.address, port: 9 });
    }
  }
  return [...new Map(list.map((d) => [d.address, d])).values()];
}

/**
 * Send the magic packet to every discovered destination.
 * Resolves with per-destination results instead of throwing, so a single
 * failed route never hides a successful send.
 */
export function sendMagicPacket(mac, { repeats = 3, broadcast = '' } = {}) {
  const packet = buildMagicPacket(mac);
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  return new Promise((resolve, reject) => {
    let settled = false;
    const results = [];

    const done = () => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(results);
    };

    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      reject(err);
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        console.warn(`setBroadcast failed: ${err.message}`);
      }

      const targets = destinations(broadcast);
      let pending = 0;
      let sentAny = false;

      for (const target of targets) {
        for (let i = 0; i < repeats; i++) {
          pending++;
          socket.send(packet, target.port, target.address, (err) => {
            if (!err && !sentAny) {
              sentAny = true;
            }
            results.push({ to: target.address, ok: !err, error: err?.message });
            if (--pending === 0) {
              // Give the kernel a beat to flush the last datagrams.
              setTimeout(done, 100);
            }
          });
        }
      }

      if (pending === 0) done();
    });
  });
}
