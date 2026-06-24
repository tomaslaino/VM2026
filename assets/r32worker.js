/* Web Worker: kör R32-simuleringen utanför huvudtråden så att UI:t inte hänger.
 * Laddar den delade motorn och svarar på { id, input } med { id, result }. */
/* global importScripts, R32Engine */
importScripts("r32engine.js");

self.onmessage = function (e) {
  var msg = e.data || {};
  try {
    var result = R32Engine.simulate(msg.input);
    self.postMessage({ seq: msg.seq, key: msg.key, result: result });
  } catch (err) {
    self.postMessage({ seq: msg.seq, key: msg.key, error: (err && err.message) || String(err) });
  }
};
