"use strict";
module.exports = Histogram;
function Histogram(histogramSize) {
  this._prev = Date.now();
  this._histogram = [];
  for (var i = 0; i < histogramSize; i++) {
    this._histogram.push(0);
  }
}

Histogram.prototype.tick = function() {
  var latency = Date.now() - this._prev;
  this._histogram.push(latency);
  this._histogram.shift();
  this._prev = Date.now();
};

Histogram.prototype.values = function() {
  return this._histogram;
};
