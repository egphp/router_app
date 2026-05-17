import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSyslog } from '../src/syslog-server.js';
import { parseLogEntry } from '../src/system-log-puller.js';

test('parseSyslog: RFC3164 with priority, timestamp, host, tag, msg', () => {
  const r = parseSyslog('<14>May 15 06:55:39 Tenda kernel: device joined');
  assert.equal(r.ts, null);
  assert.equal(r.priority, 14);
  assert.equal(r.facility, 1);
  assert.equal(r.severity, 6);
  assert.equal(r.host, 'Tenda');
  assert.equal(r.tag, 'kernel');
  assert.equal(r.message, 'device joined');
});

test('parseSyslog: raw text without priority', () => {
  const r = parseSyslog('plain text message');
  assert.equal(r.ts, null);
  assert.equal(r.priority, null);
  assert.equal(r.message, 'plain text message');
});

test('parseSyslog: extracts embedded Tenda router event time', () => {
  const r = parseSyslog('<13>AA:BB:CC:DD:EE:FF 192.168.0.2 Device user staying:[0]day [0]hour [1]minute [3]second time:2026-05-16 22:31:28');
  assert.equal(r.ts, new Date(2026, 4, 16, 22, 31, 28).getTime());
  assert.match(r.message, /user staying/);
});

test('parseLogEntry: ARP attack pattern', () => {
  const p = parseLogEntry({
    ID: 1, sysLogTime: '2026-05-15 08:52:07', sysLogType: 2,
    sysLogMsg: 'detect 506 ARP attack from 192.168.0.227/5A:C2:A6:04:63:7E',
  });
  assert.equal(p.attack_count, 506);
  assert.equal(p.attack_kind, 'ARP');
  assert.equal(p.attacker_ip, '192.168.0.227');
  assert.equal(p.attacker_mac, '5A:C2:A6:04:63:7E');
});

test('parseLogEntry: DDoS pattern with subtype', () => {
  const p = parseLogEntry({
    ID: 2, sysLogTime: '2026-05-04 17:49:30', sysLogType: 2,
    sysLogMsg: 'detect 1 DDOS (udp_attack) attack from 192.168.0.132/48:E1:5C:7D:C8:60',
  });
  assert.equal(p.attack_count, 1);
  assert.equal(p.attack_kind, 'DDOS:udp_attack');
  assert.equal(p.attacker_ip, '192.168.0.132');
  assert.equal(p.attacker_mac, '48:E1:5C:7D:C8:60');
});

test('parseLogEntry: non-attack message returns nulls', () => {
  const p = parseLogEntry({
    ID: 3, sysLogTime: '2026-05-15 09:55:10', sysLogType: 1,
    sysLogMsg: '[system] 192.168.0.7 login',
  });
  assert.equal(p.attack_count, null);
  assert.equal(p.attack_kind, null);
  assert.equal(p.attacker_mac, null);
});
