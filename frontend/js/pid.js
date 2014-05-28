"use strict";

module.exports = PID;
function PID(options) {
  this._pGain = options.pGain || 0;
  this._iGain = options.iGain || 0;
  this._dGain = options.dGain || 0;
  this._min = options.min || -1;
  this._max = options.max || 1;
  this._zero = options.zero || 0;

  this._p = 0;
  this._i = 0;
  this._d = 0;
  this._sum = 0;

  this._target = 0;
  this._sumErr = 0;
  this._lastErr = 0;
  this._lastTime = null;

  this.target(0);
}

PID.prototype.target = function(val) {
  if (val === undefined) {
    return this._target;
  }
  this._sumErr = 0;
  this._lastErr = 0;
  this._lastTime = null;
  this._sum = this._p = this._i = this._d = this._zero;
  this._target = val;
  return this._target;
};

PID.prototype.update = function(val) {
  var now = Date.now();
  var dt = 0;
  if (this._lastTime !== null) {
    dt = (now - this._lastTime) / 1000;
  }
  this._lastTime = now;

  var err = this._target - val;
  var dErr = (err - this._lastErr)*dt;
  this._sumErr += err * dt;
  this._lastErr = err;

  this._p = this._pGain*err;
  this._i = this._iGain*this._sumErr;
  this._d = this._dGain*dErr;
  this._sum = this._p+this._i+this._d;
  if (this._sum < this._min) {
    this._sum = this._min;
  } else if (this._sum > this._max) {
    this._sum = this._max;
  }
};

PID.prototype.pid = function() {
  return {p: this._p, i: this._i, d: this._d, sum: this._sum};
};
