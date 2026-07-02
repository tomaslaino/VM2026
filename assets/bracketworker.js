/* Web Worker: kör hela slutspelssimuleringen (assets/bracketengine.js) utanför
 * huvudtråden. Svarar på { seq, key, bkey?, input } med { seq, key, bkey?, result }
 * – bkey är trädets cache-nyckel när kalkylatorns körning även matar bracketProbs. */
/* global importScripts, BracketEngine */
importScripts("bracketengine.js?v=6");

self.onmessage = function (e) {
  var msg = e.data || {};
  try {
    var result = BracketEngine.compute(msg.input);
    self.postMessage({ seq: msg.seq, key: msg.key, bkey: msg.bkey, result: result });
  } catch (err) {
    self.postMessage({ seq: msg.seq, key: msg.key, error: (err && err.message) || String(err) });
  }
};
