/* Web Worker: kör hela slutspelssimuleringen (assets/bracketengine.js) utanför
 * huvudtråden. Svarar på { seq, key, input } med { seq, key, result }. */
/* global importScripts, BracketEngine */
importScripts("bracketengine.js?v=5");

self.onmessage = function (e) {
  var msg = e.data || {};
  try {
    var result = BracketEngine.compute(msg.input);
    self.postMessage({ seq: msg.seq, key: msg.key, result: result });
  } catch (err) {
    self.postMessage({ seq: msg.seq, key: msg.key, error: (err && err.message) || String(err) });
  }
};
