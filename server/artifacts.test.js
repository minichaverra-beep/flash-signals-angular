/**
 * Tests unitarios del escaneo/resolución de artefactos (sin Express).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const artifacts = require('./artifacts');

describe('artifacts.resolveSafe', () => {
  it('bloquea .. y rutas vacías', () => {
    assert.equal(artifacts.resolveSafe('').ok, false);
    assert.equal(artifacts.resolveSafe('../README.md').ok, false);
    assert.equal(artifacts.resolveSafe('foo/../../etc/passwd').ok, false);
    assert.equal(artifacts.resolveSafe('a//b').ok, false);
  });

  it('acepta path relativo bajo Artifacts', () => {
    const r = artifacts.resolveSafe('README.md');
    assert.equal(r.ok, true);
    assert.equal(r.rel, 'README.md');
    assert.ok(r.full.toLowerCase().includes('artifacts'));
  });
});

describe('artifacts.scanArtifacts', () => {
  it('lista archivos reales y no incluye basura', () => {
    const data = artifacts.scanArtifacts();
    assert.equal(data.exists, true);
    assert.ok(Array.isArray(data.items));
    assert.ok(data.count >= 1);
    const names = data.items.map((i) => i.name.toLowerCase());
    assert.ok(!names.includes('.ds_store'));
    assert.ok(!names.includes('thumbs.db'));
    const readme = data.items.find((i) => i.name === 'README.md');
    assert.ok(readme, 'README.md de ejemplo debe existir');
    assert.equal(readme.kind, 'markdown');
    assert.ok(readme.ext === '.md');
  });
});

describe('artifacts.readArtifactMeta', () => {
  it('lee markdown con content', () => {
    const r = artifacts.readArtifactMeta('README.md');
    assert.equal(r.ok, true);
    assert.ok(typeof r.content === 'string' && r.content.length > 0);
    assert.ok(r.rawUrl.includes('path='));
  });

  it('404 si no existe', () => {
    const r = artifacts.readArtifactMeta('no-existe-xyz.md');
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  });
});
