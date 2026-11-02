'use strict';

// S5 L0: the room preview relay config (relay/mediamtx.yml) stays within MediaMTX
// v1.21.3's own keys and its security shape. The key list below is every top-level
// key in the v1.21.3 mediamtx.yml (sha256 47cbbb2b7a7cd958…, fetched 2026-11-02).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const V1_21_3_KEYS = new Set(('api apiAddress apiAllowOrigins apiEncryption apiServerCert apiServerKey apiTrustedProxies authHTTPAddress authHTTPExclude authHTTPFingerprint authInternalUsers authJWTAudience authJWTClaimKey authJWTExclude authJWTIssuer authJWTJWKS authJWTJWKSFingerprint authMethod dumpPackets hls hlsAddress hlsAllowOrigins hlsAlwaysRemux hlsCDNSecret hlsDirectory hlsEncryption hlsMuxerCloseAfter hlsPartDuration hlsSegmentCount hlsSegmentDuration hlsSegmentMaxSize hlsServerCert hlsServerKey hlsTrustedProxies hlsVariant logDestinations logFile logLevel logStructured metrics metricsAddress metricsAllowOrigins metricsEncryption metricsServerCert metricsServerKey metricsTrustedProxies moq moqAllowOrigins moqHTTP2Address moqHTTP3Address moqQUICAddress moqServerCert moqServerKey moqTrustedProxies multicastIPRange multicastRTCPPort multicastRTPPort multicastSRTCPPort multicastSRTPPort pathDefaults paths playback playbackAddress playbackAllowOrigins playbackEncryption playbackServerCert playbackServerKey playbackTrustedProxies pprof pprofAddress pprofAllowOrigins pprofEncryption pprofServerCert pprofServerKey pprofTrustedProxies readTimeout rtcpAddress rtmp rtmpAddress rtmpEncryption rtmpServerCert rtmpServerKey rtmpTrustedProxies rtmpsAddress rtpAddress rtsp rtspAddress rtspAuthMethods rtspEncryption rtspServerCert rtspServerKey rtspTransports rtspTrustedProxies rtspsAddress runOnConnect runOnConnectRestart runOnDisconnect srt srtAddress srtcpAddress srtpAddress sysLogPrefix udpMaxPayloadSize udpReadBufferSize webrtc webrtcAdditionalHosts webrtcAddress webrtcAllowOrigins webrtcEncryption webrtcHandshakeTimeout webrtcICEServers2 webrtcIPsFromInterfaces webrtcIPsFromInterfacesExcludeList webrtcIPsFromInterfacesList webrtcLocalTCPAddress webrtcLocalUDPAddress webrtcSTUNGatherTimeout webrtcServerCert webrtcServerKey webrtcTrackGatherTimeout webrtcTrustedProxies writeQueueSize writeTimeout').split(' '));

const ROOT = path.join(__dirname, '..');
const yml = fs.readFileSync(path.join(ROOT, 'relay', 'mediamtx.yml'), 'utf8');
const top = Object.fromEntries(yml.split('\n')
  .filter((line) => /^[A-Za-z0-9]+:/.test(line))
  .map((line) => { const i = line.indexOf(':'); return [line.slice(0, i), line.slice(i + 1).trim()]; }));

test('every top-level key exists in MediaMTX v1.21.3', () => {
  const unknown = Object.keys(top).filter((key) => !V1_21_3_KEYS.has(key));
  assert.deepEqual(unknown, []);
});

test('only WebRTC is served, over HTTPS, to the app origin; nothing else listens', () => {
  for (const off of ['rtsp', 'rtmp', 'hls', 'srt', 'moq', 'metrics', 'pprof', 'playback']) assert.equal(top[off], 'false', off);
  assert.equal(top.webrtc, 'true');
  assert.equal(top.webrtcEncryption, 'true');
  assert.equal(top.webrtcAllowOrigins, "['capacitor://localhost']");
  assert.equal(top.apiAddress, '127.0.0.1:9997', 'the control API is local only');
});

test('reads and publishes are checked by the ES Worker; only the local API is excluded', () => {
  assert.equal(top.authMethod, 'http');
  assert.equal(top.authHTTPAddress, 'https://api.evrybdystudios.com/api/preview-auth');
  const exclude = yml.slice(yml.indexOf('authHTTPExclude:'), yml.indexOf('\n\n', yml.indexOf('authHTTPExclude:')));
  assert.deepEqual(exclude.split('\n').slice(1).map((l) => l.trim()), ['- action: api']);
  assert.equal(/authInternalUsers|authJWT/.test(yml.replace(/^#.*$/gm, '')), false);
});

test('one room path, published only by a publisher; the forward is set at run time, never stored', () => {
  assert.match(yml, /\npaths:\n {2}__ROOM_PATH__:\n {4}source: publisher\n/);
  assert.equal(/^\s*forward:\s*\[|^\s*- dest:/m.test(yml), false);
  assert.equal(/cloudflarestream\.com/.test(yml), false);
});

test('the relay is not part of the self-updating agent package', () => {
  const modules = fs.readFileSync(path.join(ROOT, 'modules.txt'), 'utf8');
  assert.equal(/relay\/|mediamtx/.test(modules), false);
  const plist = fs.readFileSync(path.join(ROOT, 'relay', 'com.es.preview-relay.plist'), 'utf8');
  assert.match(plist, /<string>com\.es\.preview-relay<\/string>/);
  assert.equal(/Documents/.test(plist), false, 'launchd must not run anything from ~/Documents');
});
