/* global window, WebSocket */ 
"use strict";
module.exports = WsClient;
function WsClient() {
  this._conn = null;
  this._connected = false;
  this._queue = [];
  this._listeners = {};
  this._takeoffCbs = [];
  this._landCbs = [];
  this._connect();
  this.upDown = 0;
  this.frontBack = 0;
  this.rotation = 0;
}

WsClient.prototype._connect = function() {
  var self = this;
  self._conn = new WebSocket('ws://'+window.location.host);
  self._conn.onopen = function() {
    self._connected = true;
    self._queue.forEach(function(msg) {
      self._conn.send(msg);
    });
    self._queue = [];

    self._conn.onmessage = function(msg) {
      try {
        msg = JSON.parse(msg.data);
      } catch (err) {
        console.error(err);
        return;
      }
      var kind = msg.shift();
      switch (kind) {
        case 'takeoff':
          self._takeoffCbs.forEach(function(cb) {
            cb();
          });
          self._takeoffCbs = [];
          break;
        case 'land':
          self._landCbs.forEach(function(cb) {
            cb();
          });
          self._landCbs = [];
          break;
        case 'on':
          var event = msg.shift();
          self._listeners[event].forEach(function(cb) {
            cb.apply(self, msg);
          });
          break;
        default:
          console.error('unknown message: '+kind);
      }
    };
  };

};

WsClient.prototype._send = function(msg) {
  if(msg && msg.length === 2 && msg[1] === 0){
    msg[1] = 0.001;
  }
  msg = JSON.stringify(msg);
  if (!this._connected) {
    this._queue.push(msg);
    return;
  }
  this._conn.send(msg);
};

WsClient.prototype.on = function(event, cb) {
  var cbs = this._listeners[event] = this._listeners[event] || [];
  cbs.push(cb);
  if (cbs.length === 1) {
    this._send(['on', event]);
  }
};

WsClient.prototype.takeoff = function(cb) {
  this._send(['takeoff']);
  if (cb) {
    this._takeoffCbs.push(cb);
  }
};

WsClient.prototype.land = function(cb) {
  this._send(['land']);
  if (cb) {
    this._landCbs.push(cb);
  }
};

WsClient.prototype.right = function(val) {
  this._send(['right', val]);
};

WsClient.prototype.clockwise = function(val) {
  this._send(['clockwise', val]);
};

WsClient.prototype.down = function(val) {
  this._send(['down', val]);
  this.upDown = -val;
};

WsClient.prototype.up = function(val) {
  this._send(['up', val]);
  this.upDown = val;
};

WsClient.prototype.turnaround = function(val) {
  this._send(['turnaround', val]);
};

WsClient.prototype.front = function(val) {
  this.frontBack = val;
  this._send(['front', val]);
};

WsClient.prototype.clockwise = function(val) {
  this._send(['clockwise', val]);
  this.rotation = val;
};


WsClient.prototype.stop = function() {
  this._send(['stop']);
  this.frontBack = 0;
  this.upDown = 0;
  this.roatation = 0;
};
