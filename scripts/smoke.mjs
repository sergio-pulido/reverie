import assert from 'node:assert/strict';

const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4317';
for (const path of ['/api/health', '/jams/new', '/jams/test-room', '/join', '/discover', '/api/missing']) {
  const response = await fetch(new URL(path, baseUrl));
  assert.equal(response.status, path === '/api/missing' ? 404 : 200, path);
  if (path === '/api/health') {
    assert.deepEqual(await response.json(), { status: 'ok', service: 'reverie-movie-jam' });
  } else if (!path.startsWith('/api/')) {
    assert.match(await response.text(), /<div id="root"><\/div>/, path);
  }
  console.log(`PASS ${path}`);
}

// The catalogue route must answer with a validated status, never with invented titles.
const catalogue = await fetch(new URL('/api/catalogue?query=space&page=1&pageSize=12', baseUrl));
assert.equal(catalogue.status, 200, '/api/catalogue');
const body = await catalogue.json();
assert.ok(['ok', 'catalogue_not_configured'].includes(body.status), `unexpected status ${body.status}`);
if (body.status === 'catalogue_not_configured') {
  assert.equal(body.code, 'CATALOGUE_NOT_CONFIGURED');
  assert.ok(Array.isArray(body.missing) && body.missing.length > 0);
} else {
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.every((item) => typeof item.id === 'string' && item.id.startsWith('cat:')));
}
console.log(`PASS /api/catalogue (${body.status})`);

// Query limits are enforced.
const rejected = await fetch(new URL('/api/catalogue?pageSize=500', baseUrl));
assert.equal(rejected.status, 400, 'pageSize limit');
assert.equal((await rejected.json()).code, 'INVALID_QUERY');
console.log('PASS /api/catalogue query limits');

// Cross-origin browser calls are refused.
const crossOrigin = await fetch(new URL('/api/catalogue', baseUrl), { headers: { Origin: 'https://evil.example' } });
assert.equal(crossOrigin.status, 403, 'cross-origin');
assert.equal((await crossOrigin.json()).code, 'CROSS_ORIGIN_BLOCKED');
console.log('PASS /api/catalogue same-origin guard');
