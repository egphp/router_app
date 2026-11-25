import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';

describe('public privacy page', () => {
  it('does not send an anonymous reader to the passkey login', () => {
    const res = middleware(new NextRequest('https://tv-eg.com:2055/privacy', {
      headers: { host: 'tv-eg.com:2055' },
    }));
    assert.notEqual(res.status, 307);
    assert.notEqual(res.headers.get('location'), '/login?next=%2Fprivacy');
    assert.equal(res.status, 200);
  });
});
