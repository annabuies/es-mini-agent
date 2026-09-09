'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { contentTypeForKey } = require('../storage-upload');

test('contentTypeForKey identifies inline-playable audio and video uploads', () => {
  assert.equal(contentTypeForKey('recordings/bench-1/audio/take-mic1.m4a'), 'audio/mp4');
  assert.equal(contentTypeForKey('recordings/bench-1/audio/take.aac'), 'audio/aac');
  assert.equal(contentTypeForKey('recordings/bench-1/audio/take.wav'), 'audio/wav');
  assert.equal(contentTypeForKey('recordings/bench-1/master/take.mov'), 'video/quicktime');
  assert.equal(contentTypeForKey('recordings/bench-1/master/take.MP4'), 'video/mp4');
  assert.equal(contentTypeForKey('recordings/bench-1/master/take.mkv'), 'video/x-matroska');
  assert.equal(contentTypeForKey('recordings/bench-1/notes.txt'), null);
});
