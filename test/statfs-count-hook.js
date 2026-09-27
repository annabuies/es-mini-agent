'use strict';

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');

const originalStatfs = fsPromises.statfs;
fsPromises.statfs = async function countedStatfs(...args) {
  fs.appendFileSync(process.env.STATFS_COUNT_LOG, 'statfs\n');
  return originalStatfs.apply(this, args);
};
