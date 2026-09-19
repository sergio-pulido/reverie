import assert from 'node:assert/strict';

const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4317';
for (const path of ['/api/health', '/jams/new', '/jams/test-room', '/join', '/api/missing']) {
  const response = await fetch(new URL(path, baseUrl));
  assert.equal(response.status, path === '/api/missing' ? 404 : 200, path);
  if (path === '/api/health') {
    assert.deepEqual(await response.json(), { status: 'ok', service: 'reverie-movie-jam' });
  } else if (!path.startsWith('/api/')) {
    assert.match(await response.text(), /<div id="root"><\/div>/, path);
  }
  console.log(`PASS ${path}`);
}
