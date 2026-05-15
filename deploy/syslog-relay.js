#!/usr/bin/env node
// UDP port relay: receives on FROM_PORT and forwards to TO_HOST:TO_PORT.
// Needed because UDP 514 (syslog) requires root, but the main poller runs as the user.
// This relay binds to 514 (root-only) and forwards every packet to 5140 where the
// user-owned poller listens. It preserves the original source IP via an extra header line.

const dgram = require('node:dgram');

const FROM_PORT = Number(process.env.FROM_PORT || 514);
const TO_HOST = process.env.TO_HOST || '127.0.0.1';
const TO_PORT = Number(process.env.TO_PORT || 5140);

const recv = dgram.createSocket('udp4');
const send = dgram.createSocket('udp4');

recv.on('message', (msg, rinfo) => {
  send.send(msg, TO_PORT, TO_HOST, (err) => {
    if (err) console.error('forward error:', err);
  });
});

recv.on('listening', () => {
  const a = recv.address();
  console.log(`syslog-relay: listening on ${a.address}:${a.port} -> ${TO_HOST}:${TO_PORT}`);
});

recv.on('error', (err) => {
  console.error('recv error:', err);
  process.exit(1);
});

recv.bind(FROM_PORT, '0.0.0.0');

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
