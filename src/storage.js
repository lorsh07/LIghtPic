const fs = require('fs/promises');
const path = require('path');
const { customAlphabet } = require('nanoid');

const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);
const ID_RE = /^[0-9a-z]{12}$/;

function createStorage(dataDir) {
  const dirs = {
    masters: path.join(dataDir, 'masters'),
    meta: path.join(dataDir, 'meta'),
    cache: path.join(dataDir, 'cache'),
  };

  async function init() {
    await Promise.all(Object.values(dirs).map((d) => fs.mkdir(d, { recursive: true })));
  }

  const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);
  const masterPath = (id, ext) => path.join(dirs.masters, `${id}.${ext}`);
  const metaPath = (id) => path.join(dirs.meta, `${id}.json`);

  async function writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  }

  async function saveImage(buffer, meta) {
    const id = newId();
    const record = { id, ...meta, createdAt: new Date().toISOString() };
    await writeAtomic(masterPath(id, meta.ext), buffer);
    await writeAtomic(metaPath(id), JSON.stringify(record, null, 2));
    return record;
  }

  async function getMeta(id) {
    if (!isValidId(id)) return null;
    try {
      return JSON.parse(await fs.readFile(metaPath(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function readMaster(meta) {
    return fs.readFile(masterPath(meta.id, meta.ext));
  }

  const cachePath = (key, ext) => path.join(dirs.cache, `${key}.${ext}`);

  async function readCache(key, ext) {
    try {
      return await fs.readFile(cachePath(key, ext));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeCache(key, ext, buffer) {
    await writeAtomic(cachePath(key, ext), buffer);
  }

  return { init, isValidId, saveImage, getMeta, readMaster, readCache, writeCache };
}

module.exports = { createStorage };
