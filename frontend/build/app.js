(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
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

},{}],2:[function(require,module,exports){
/* global document, NodecopterStream, window, requestAnimationFrame, Uint8Array */
"use strict";
var Histogram = require('./histogram');
var WsClient = require('./ws_client');
var PID = require('./pid');

var videoDiv = document.getElementById('video');
var ns = new NodecopterStream(videoDiv, {port: 3001});
var videoCanvas = videoDiv.querySelector('canvas');
var aspectRatio = videoCanvas.width / videoCanvas.height;
var overlayCanvas = document.getElementById('overlay');
var overlayContext = overlayCanvas.getContext('2d');
var frameBuffer = new Uint8Array(videoCanvas.width * videoCanvas.height * 4);
var videoHistogram = new Histogram(200);
var navdataHistogram = new Histogram(200);
var render = renderer();
var detect = detector({maxDiff: 0.07});
var lastNavdata;
var pickedColor;
var detected;
var xPID = new PID({pGain: 0.15, iGain: 0, dGain: 0});
var yPID = new PID({pGain: 0.15, iGain: 0, dGain: 0});
var client = new WsClient();
var state;
setState('ground');

// main gets this party started.
(function main() {
  maximizeVideo();
  renderLoop();
  ns.onNextFrame(frameLoop);
  client.on('navdata', function (data) {
    lastNavdata = data;
    navdataHistogram.tick();
  });
})();

// renderLoop drives the renderer.
function renderLoop() {
  render();
  requestAnimationFrame(renderLoop);
}

// frameLoop analyzes incoming video frames.
function frameLoop() {
  videoHistogram.tick();

  if (pickedColor) {
    detect();
  }

  ns.onNextFrame(frameLoop);
}

// detector returns a function that tries to find a colored object in the image.
function detector(options) {
  var maxDiff = options.maxDiff;
  var w = videoCanvas.width;
  var h = videoCanvas.height;
  var b = frameBuffer;

  var missCnt = 0;

  return function detect() {
    ns.getImageData(b);

    var count = 0;
    var xSum = 0;
    var ySum = 0;
    for (var x = 1; x < w - 1; x++) {
      for (var y = 1; y < h - 1; y++) {
        var match = true;
        for (var xj = -1; xj <= 1 && match; xj++) {
          for (var yj = -1; yj <= 1 && match; yj++) {
            var o = (x + xj) * 4 + (h - (y + yj)) * w * 4;
            for (var i = 0; i < pickedColor.length && match; i++) {
              var diffPercent = Math.abs(b[o + i] - pickedColor[i]) / 255;
              if (diffPercent > maxDiff) {
                match = false;
              }
            }
          }
        }

        if (match) {
          count++;
          xSum += x;
          ySum += y;
        }
      }
    }
    detected = {x: xSum / count, y: ySum / count};
    var xVal = (detected.x - w / 2) / (w / 2);
    var yVal = (detected.y - h / 2) / (h / 2);
    xPID.update(xVal);
    yPID.update(yVal);

    if (state === 'follow') {
      if (xSum < 25) {
        missCnt += 1;
        if(missCnt < 2) {
          client.stop();
        }
        if (missCnt > 20) {
          client.clockwise(0.1);
        }
      } else {
        missCnt = 0;
        client.clockwise(-xPID.pid().sum);
        client.front(0.1);
      }
    } else {
      client.stop();
    }
  };
}

// renderer returns a function to render the overlay canvas. The coordinate
// system is set up so that (0,0) is the top left of the canvas.
function renderer() {
  var padding = 10;
  var spacing = 20;
  var c = overlayContext;
  var w = overlayCanvas.width;
  var h = overlayCanvas.height;
  var opacity = 0.3;

  function renderHistograms(histograms) {
    var offset = 0;
    histograms.forEach(function (h) {
      renderHistogram(h.label, h.values, h.limit, offset);
      offset += h.values.length + spacing;
    });
  }

  function renderHistogram(label, values, limit, offset) {
    // offset is number of pixels from right to offset the histogram.
    offset = offset || 0;
    var fontSize = 20;

    c.fillStyle = 'rgba(255,255,255,' + opacity + ')';
    c.font = fontSize + 'px Arial';
    var labelWidth = c.measureText(label).width;
    c.fillText(label, w - (labelWidth / 2) - (values.length / 2) - padding - offset, h - padding);

    for (var i = 0; i < values.length; i++) {
      var x = w - i - padding - offset;
      c.beginPath();
      c.moveTo(x, h - fontSize - padding);
      c.lineTo(x, h - values[i] - fontSize - padding);
      c.strokeStyle = 'rgba(255,255,255,' + opacity + ')';
      c.stroke();
    }

    var limitY = h - fontSize - padding - limit;
    c.beginPath();
    c.moveTo(w - padding - values.length - offset, limitY);
    c.lineTo(w - padding - offset, limitY);
    c.strokeStyle = 'rgba(255,0,0,' + opacity + ')';
    c.stroke();
  }

  return function render() {
    c.clearRect(0, 0, w, h);

    // detected object
    (function () {
      if (!detected) {
        return;
      }

      var x = videoToOverlayX(detected.x);
      var y = videoToOverlayY(detected.y);

      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, overlayCanvas.height);
      c.strokeStyle = 'rgba(255,0,0,1)';
      c.stroke();

      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(overlayCanvas.width, y);
      c.strokeStyle = 'rgba(255,0,0,1)';
      c.stroke();
    })();

    // xPID
    (function () {
      var pid = xPID.pid();
      var fontSize = 14;
      var bars = [
        {label: 'p', val: pid.p, color: '255,0,0'},
        {label: 'i', val: pid.i, color: '0,255,0'},
        {label: 'd', val: pid.d, color: '0,0,255'},
        {label: 'pid', val: pid.sum, color: '255,255,255'}
      ];
      var bh = 10;
      var yo = h / 2 - ((bh + fontSize + padding) * bars.length) / 2;

      bars.forEach(function (bar, i) {
        var y = yo + i * (bh + fontSize + padding);
        var bw = Math.abs(bar.val * w / 2);
        var x = w / 2;
        if (bar.val > 0) {
          x -= bw;
        }
        c.fillStyle = 'rgba(' + bar.color + ',' + opacity * 2 + ')';
        c.fillRect(x, y, bw, bh);

        c.fillStyle = 'rgba(255,255,255,' + opacity + ')';
        c.font = fontSize + 'px Arial';
        c.fillText(bar.label, w / 2, y - padding);
      });

    })();

    renderHistograms([
      {label: 'video', values: videoHistogram.values(), limit: 1000 / 30},
      {label: 'navdata', values: navdataHistogram.values(), limit: 1000 / 15}
    ]);

    // battery meter
    (function () {
      var value;
      try {
        value = lastNavdata.demo.batteryPercentage;
      } catch (err) {
        value = 0;
      }
      var fullWidth = 70;
      var fullHeight = 24;
      var fontSize = 14;
      var width = (fullWidth - 2) * value / 100;
      var label = value + ' %';
      var x = w - fullWidth - padding;
      var y = padding;

      c.fillStyle = 'rgba(255,255,255,' + opacity + ')';
      c.fillRect(x, y, fullWidth, fullHeight);
      if (value < 30) {
        c.fillStyle = 'rgba(255,0,0,' + opacity + ')';
      } else if (value < 50) {
        c.fillStyle = 'rgba(255,255,0,' + opacity + ')';
      } else {
        c.fillStyle = 'rgba(0,255,0,' + opacity + ')';
      }
      c.fillRect(x + 1, y + 1, width, fullHeight - 2);

      c.fillStyle = 'rgba(0,0,0,' + opacity + ')';
      c.font = fontSize + 'px Arial';
      var labelWidth = c.measureText(label).width;
      c.fillText(label, x + (fullWidth / 2) - (labelWidth / 2), y + (fullHeight / 2) + (fontSize / 2) - 1);
    })();

    // color picker
    (function () {
      var x = padding;
      var y = padding;
      var size = 50;
      c.fillStyle = 'rgba(255,255,255,' + opacity + ')';
      c.fillRect(x, y, size, size);

      if (pickedColor) {
        c.fillStyle = 'rgba(' + pickedColor[0] + ',' + pickedColor[1] + ',' + pickedColor[2] + ',1)';
        c.fillRect(x + 1, y + 1, size - 2, size - 2);
      }
    })();
  };
}

// Keep video maximized within browser window while keeping the aspect ratio
// intact.
window.addEventListener('resize', maximizeVideo);
function maximizeVideo() {
  var width, height;
  var windowRatio = window.innerWidth / window.innerHeight;
  if (windowRatio > aspectRatio) {
    height = window.innerHeight;
    width = height * aspectRatio;
  } else {
    width = window.innerWidth;
    height = width / aspectRatio;
  }
  [videoCanvas, overlayCanvas].forEach(function (canvas) {
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    canvas.style.marginTop = ((window.innerHeight - height) / 2) + 'px';
    canvas.style.marginLeft = ((window.innerWidth - width) / 2) + 'px';
  });
}

overlayCanvas.addEventListener('click', function (event) {
  var x = overlayToVideoX(event.offsetX);
  var y = overlayToVideoY(event.offsetY);
  pickedColor = pickedColor || new Uint8Array(4);
  ns.getImageData(pickedColor, x, videoCanvas.height - y, 1, 1);
});

function overlayToVideoX(x) {
  return Math.round((x / parseFloat(videoCanvas.style.width)) * videoCanvas.width);
}

function overlayToVideoY(y) {
  return Math.round((y / parseFloat(videoCanvas.style.height)) * videoCanvas.height);
}

function videoToOverlayX(x) {
  return Math.round(x / videoCanvas.width * overlayCanvas.width);
}

function videoToOverlayY(y) {
  return Math.round(y / videoCanvas.height * overlayCanvas.height);
}

function setState(val) {
  console.log('new state: ' + val);
  state = val;
}

var flightButton = document.getElementById('flight');
flightButton.addEventListener('click', function () {
  if (this.textContent === 'Start') {
    setState('takeoff');
    client.on('altitudeChange', function (v) {
      if (v < 0.1) {
        this.up(0.02);
      } else if (v < 0.3) {
        this.down(0);
      } else if (v > 0.6) {
        this.down(0.3);
      } else if (v > 0.5) {
        this.down(0.1);
      } else if (v > 0.4) {
        this.down(0.05);
      }
    }
  );
  client.takeoff(function () {
    setState('follow');
    client.down(0.1);
  });
  this.textContent = 'Stop';
}
else
{
  setState('land');
  client.land(function () {
    setState('ground');
  });
  this.textContent = 'Start';
}
})
;

},{"./histogram":1,"./pid":3,"./ws_client":4}],3:[function(require,module,exports){
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

},{}],4:[function(require,module,exports){
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
};

WsClient.prototype.up = function(val) {
  this._send(['up', val]);
};

WsClient.prototype.front = function(val) {
  this._send(['front', val]);
};

WsClient.prototype.clockwise = function(val) {
  this._send(['clockwise', val]);
};


WsClient.prototype.stop = function() {
  this._send(['stop']);
};

},{}]},{},[2])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlcyI6WyIvaG9tZS9jaHVjay9kZXYvd29ya3NwYWNlL2FyZHJvbmUtZm9vdGJhbGwvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsIi9ob21lL2NodWNrL2Rldi93b3Jrc3BhY2UvYXJkcm9uZS1mb290YmFsbC9mcm9udGVuZC9qcy9oaXN0b2dyYW0uanMiLCIvaG9tZS9jaHVjay9kZXYvd29ya3NwYWNlL2FyZHJvbmUtZm9vdGJhbGwvZnJvbnRlbmQvanMvbWFpbi5qcyIsIi9ob21lL2NodWNrL2Rldi93b3Jrc3BhY2UvYXJkcm9uZS1mb290YmFsbC9mcm9udGVuZC9qcy9waWQuanMiLCIvaG9tZS9jaHVjay9kZXYvd29ya3NwYWNlL2FyZHJvbmUtZm9vdGJhbGwvZnJvbnRlbmQvanMvd3NfY2xpZW50LmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsV0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt0aHJvdyBuZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpfXZhciBmPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChmLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGYsZi5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCJcInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID0gSGlzdG9ncmFtO1xuZnVuY3Rpb24gSGlzdG9ncmFtKGhpc3RvZ3JhbVNpemUpIHtcbiAgdGhpcy5fcHJldiA9IERhdGUubm93KCk7XG4gIHRoaXMuX2hpc3RvZ3JhbSA9IFtdO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGhpc3RvZ3JhbVNpemU7IGkrKykge1xuICAgIHRoaXMuX2hpc3RvZ3JhbS5wdXNoKDApO1xuICB9XG59XG5cbkhpc3RvZ3JhbS5wcm90b3R5cGUudGljayA9IGZ1bmN0aW9uKCkge1xuICB2YXIgbGF0ZW5jeSA9IERhdGUubm93KCkgLSB0aGlzLl9wcmV2O1xuICB0aGlzLl9oaXN0b2dyYW0ucHVzaChsYXRlbmN5KTtcbiAgdGhpcy5faGlzdG9ncmFtLnNoaWZ0KCk7XG4gIHRoaXMuX3ByZXYgPSBEYXRlLm5vdygpO1xufTtcblxuSGlzdG9ncmFtLnByb3RvdHlwZS52YWx1ZXMgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuX2hpc3RvZ3JhbTtcbn07XG4iLCIvKiBnbG9iYWwgZG9jdW1lbnQsIE5vZGVjb3B0ZXJTdHJlYW0sIHdpbmRvdywgcmVxdWVzdEFuaW1hdGlvbkZyYW1lLCBVaW50OEFycmF5ICovXG5cInVzZSBzdHJpY3RcIjtcbnZhciBIaXN0b2dyYW0gPSByZXF1aXJlKCcuL2hpc3RvZ3JhbScpO1xudmFyIFdzQ2xpZW50ID0gcmVxdWlyZSgnLi93c19jbGllbnQnKTtcbnZhciBQSUQgPSByZXF1aXJlKCcuL3BpZCcpO1xuXG52YXIgdmlkZW9EaXYgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndmlkZW8nKTtcbnZhciBucyA9IG5ldyBOb2RlY29wdGVyU3RyZWFtKHZpZGVvRGl2LCB7cG9ydDogMzAwMX0pO1xudmFyIHZpZGVvQ2FudmFzID0gdmlkZW9EaXYucXVlcnlTZWxlY3RvcignY2FudmFzJyk7XG52YXIgYXNwZWN0UmF0aW8gPSB2aWRlb0NhbnZhcy53aWR0aCAvIHZpZGVvQ2FudmFzLmhlaWdodDtcbnZhciBvdmVybGF5Q2FudmFzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ292ZXJsYXknKTtcbnZhciBvdmVybGF5Q29udGV4dCA9IG92ZXJsYXlDYW52YXMuZ2V0Q29udGV4dCgnMmQnKTtcbnZhciBmcmFtZUJ1ZmZlciA9IG5ldyBVaW50OEFycmF5KHZpZGVvQ2FudmFzLndpZHRoICogdmlkZW9DYW52YXMuaGVpZ2h0ICogNCk7XG52YXIgdmlkZW9IaXN0b2dyYW0gPSBuZXcgSGlzdG9ncmFtKDIwMCk7XG52YXIgbmF2ZGF0YUhpc3RvZ3JhbSA9IG5ldyBIaXN0b2dyYW0oMjAwKTtcbnZhciByZW5kZXIgPSByZW5kZXJlcigpO1xudmFyIGRldGVjdCA9IGRldGVjdG9yKHttYXhEaWZmOiAwLjA3fSk7XG52YXIgbGFzdE5hdmRhdGE7XG52YXIgcGlja2VkQ29sb3I7XG52YXIgZGV0ZWN0ZWQ7XG52YXIgeFBJRCA9IG5ldyBQSUQoe3BHYWluOiAwLjE1LCBpR2FpbjogMCwgZEdhaW46IDB9KTtcbnZhciB5UElEID0gbmV3IFBJRCh7cEdhaW46IDAuMTUsIGlHYWluOiAwLCBkR2FpbjogMH0pO1xudmFyIGNsaWVudCA9IG5ldyBXc0NsaWVudCgpO1xudmFyIHN0YXRlO1xuc2V0U3RhdGUoJ2dyb3VuZCcpO1xuXG4vLyBtYWluIGdldHMgdGhpcyBwYXJ0eSBzdGFydGVkLlxuKGZ1bmN0aW9uIG1haW4oKSB7XG4gIG1heGltaXplVmlkZW8oKTtcbiAgcmVuZGVyTG9vcCgpO1xuICBucy5vbk5leHRGcmFtZShmcmFtZUxvb3ApO1xuICBjbGllbnQub24oJ25hdmRhdGEnLCBmdW5jdGlvbiAoZGF0YSkge1xuICAgIGxhc3ROYXZkYXRhID0gZGF0YTtcbiAgICBuYXZkYXRhSGlzdG9ncmFtLnRpY2soKTtcbiAgfSk7XG59KSgpO1xuXG4vLyByZW5kZXJMb29wIGRyaXZlcyB0aGUgcmVuZGVyZXIuXG5mdW5jdGlvbiByZW5kZXJMb29wKCkge1xuICByZW5kZXIoKTtcbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKHJlbmRlckxvb3ApO1xufVxuXG4vLyBmcmFtZUxvb3AgYW5hbHl6ZXMgaW5jb21pbmcgdmlkZW8gZnJhbWVzLlxuZnVuY3Rpb24gZnJhbWVMb29wKCkge1xuICB2aWRlb0hpc3RvZ3JhbS50aWNrKCk7XG5cbiAgaWYgKHBpY2tlZENvbG9yKSB7XG4gICAgZGV0ZWN0KCk7XG4gIH1cblxuICBucy5vbk5leHRGcmFtZShmcmFtZUxvb3ApO1xufVxuXG4vLyBkZXRlY3RvciByZXR1cm5zIGEgZnVuY3Rpb24gdGhhdCB0cmllcyB0byBmaW5kIGEgY29sb3JlZCBvYmplY3QgaW4gdGhlIGltYWdlLlxuZnVuY3Rpb24gZGV0ZWN0b3Iob3B0aW9ucykge1xuICB2YXIgbWF4RGlmZiA9IG9wdGlvbnMubWF4RGlmZjtcbiAgdmFyIHcgPSB2aWRlb0NhbnZhcy53aWR0aDtcbiAgdmFyIGggPSB2aWRlb0NhbnZhcy5oZWlnaHQ7XG4gIHZhciBiID0gZnJhbWVCdWZmZXI7XG5cbiAgdmFyIG1pc3NDbnQgPSAwO1xuXG4gIHJldHVybiBmdW5jdGlvbiBkZXRlY3QoKSB7XG4gICAgbnMuZ2V0SW1hZ2VEYXRhKGIpO1xuXG4gICAgdmFyIGNvdW50ID0gMDtcbiAgICB2YXIgeFN1bSA9IDA7XG4gICAgdmFyIHlTdW0gPSAwO1xuICAgIGZvciAodmFyIHggPSAxOyB4IDwgdyAtIDE7IHgrKykge1xuICAgICAgZm9yICh2YXIgeSA9IDE7IHkgPCBoIC0gMTsgeSsrKSB7XG4gICAgICAgIHZhciBtYXRjaCA9IHRydWU7XG4gICAgICAgIGZvciAodmFyIHhqID0gLTE7IHhqIDw9IDEgJiYgbWF0Y2g7IHhqKyspIHtcbiAgICAgICAgICBmb3IgKHZhciB5aiA9IC0xOyB5aiA8PSAxICYmIG1hdGNoOyB5aisrKSB7XG4gICAgICAgICAgICB2YXIgbyA9ICh4ICsgeGopICogNCArIChoIC0gKHkgKyB5aikpICogdyAqIDQ7XG4gICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHBpY2tlZENvbG9yLmxlbmd0aCAmJiBtYXRjaDsgaSsrKSB7XG4gICAgICAgICAgICAgIHZhciBkaWZmUGVyY2VudCA9IE1hdGguYWJzKGJbbyArIGldIC0gcGlja2VkQ29sb3JbaV0pIC8gMjU1O1xuICAgICAgICAgICAgICBpZiAoZGlmZlBlcmNlbnQgPiBtYXhEaWZmKSB7XG4gICAgICAgICAgICAgICAgbWF0Y2ggPSBmYWxzZTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICAgIGNvdW50Kys7XG4gICAgICAgICAgeFN1bSArPSB4O1xuICAgICAgICAgIHlTdW0gKz0geTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBkZXRlY3RlZCA9IHt4OiB4U3VtIC8gY291bnQsIHk6IHlTdW0gLyBjb3VudH07XG4gICAgdmFyIHhWYWwgPSAoZGV0ZWN0ZWQueCAtIHcgLyAyKSAvICh3IC8gMik7XG4gICAgdmFyIHlWYWwgPSAoZGV0ZWN0ZWQueSAtIGggLyAyKSAvIChoIC8gMik7XG4gICAgeFBJRC51cGRhdGUoeFZhbCk7XG4gICAgeVBJRC51cGRhdGUoeVZhbCk7XG5cbiAgICBpZiAoc3RhdGUgPT09ICdmb2xsb3cnKSB7XG4gICAgICBpZiAoeFN1bSA8IDI1KSB7XG4gICAgICAgIG1pc3NDbnQgKz0gMTtcbiAgICAgICAgaWYobWlzc0NudCA8IDIpIHtcbiAgICAgICAgICBjbGllbnQuc3RvcCgpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChtaXNzQ250ID4gMjApIHtcbiAgICAgICAgICBjbGllbnQuY2xvY2t3aXNlKDAuMSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG1pc3NDbnQgPSAwO1xuICAgICAgICBjbGllbnQuY2xvY2t3aXNlKC14UElELnBpZCgpLnN1bSk7XG4gICAgICAgIGNsaWVudC5mcm9udCgwLjEpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBjbGllbnQuc3RvcCgpO1xuICAgIH1cbiAgfTtcbn1cblxuLy8gcmVuZGVyZXIgcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbmRlciB0aGUgb3ZlcmxheSBjYW52YXMuIFRoZSBjb29yZGluYXRlXG4vLyBzeXN0ZW0gaXMgc2V0IHVwIHNvIHRoYXQgKDAsMCkgaXMgdGhlIHRvcCBsZWZ0IG9mIHRoZSBjYW52YXMuXG5mdW5jdGlvbiByZW5kZXJlcigpIHtcbiAgdmFyIHBhZGRpbmcgPSAxMDtcbiAgdmFyIHNwYWNpbmcgPSAyMDtcbiAgdmFyIGMgPSBvdmVybGF5Q29udGV4dDtcbiAgdmFyIHcgPSBvdmVybGF5Q2FudmFzLndpZHRoO1xuICB2YXIgaCA9IG92ZXJsYXlDYW52YXMuaGVpZ2h0O1xuICB2YXIgb3BhY2l0eSA9IDAuMztcblxuICBmdW5jdGlvbiByZW5kZXJIaXN0b2dyYW1zKGhpc3RvZ3JhbXMpIHtcbiAgICB2YXIgb2Zmc2V0ID0gMDtcbiAgICBoaXN0b2dyYW1zLmZvckVhY2goZnVuY3Rpb24gKGgpIHtcbiAgICAgIHJlbmRlckhpc3RvZ3JhbShoLmxhYmVsLCBoLnZhbHVlcywgaC5saW1pdCwgb2Zmc2V0KTtcbiAgICAgIG9mZnNldCArPSBoLnZhbHVlcy5sZW5ndGggKyBzcGFjaW5nO1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVuZGVySGlzdG9ncmFtKGxhYmVsLCB2YWx1ZXMsIGxpbWl0LCBvZmZzZXQpIHtcbiAgICAvLyBvZmZzZXQgaXMgbnVtYmVyIG9mIHBpeGVscyBmcm9tIHJpZ2h0IHRvIG9mZnNldCB0aGUgaGlzdG9ncmFtLlxuICAgIG9mZnNldCA9IG9mZnNldCB8fCAwO1xuICAgIHZhciBmb250U2l6ZSA9IDIwO1xuXG4gICAgYy5maWxsU3R5bGUgPSAncmdiYSgyNTUsMjU1LDI1NSwnICsgb3BhY2l0eSArICcpJztcbiAgICBjLmZvbnQgPSBmb250U2l6ZSArICdweCBBcmlhbCc7XG4gICAgdmFyIGxhYmVsV2lkdGggPSBjLm1lYXN1cmVUZXh0KGxhYmVsKS53aWR0aDtcbiAgICBjLmZpbGxUZXh0KGxhYmVsLCB3IC0gKGxhYmVsV2lkdGggLyAyKSAtICh2YWx1ZXMubGVuZ3RoIC8gMikgLSBwYWRkaW5nIC0gb2Zmc2V0LCBoIC0gcGFkZGluZyk7XG5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHZhbHVlcy5sZW5ndGg7IGkrKykge1xuICAgICAgdmFyIHggPSB3IC0gaSAtIHBhZGRpbmcgLSBvZmZzZXQ7XG4gICAgICBjLmJlZ2luUGF0aCgpO1xuICAgICAgYy5tb3ZlVG8oeCwgaCAtIGZvbnRTaXplIC0gcGFkZGluZyk7XG4gICAgICBjLmxpbmVUbyh4LCBoIC0gdmFsdWVzW2ldIC0gZm9udFNpemUgLSBwYWRkaW5nKTtcbiAgICAgIGMuc3Ryb2tlU3R5bGUgPSAncmdiYSgyNTUsMjU1LDI1NSwnICsgb3BhY2l0eSArICcpJztcbiAgICAgIGMuc3Ryb2tlKCk7XG4gICAgfVxuXG4gICAgdmFyIGxpbWl0WSA9IGggLSBmb250U2l6ZSAtIHBhZGRpbmcgLSBsaW1pdDtcbiAgICBjLmJlZ2luUGF0aCgpO1xuICAgIGMubW92ZVRvKHcgLSBwYWRkaW5nIC0gdmFsdWVzLmxlbmd0aCAtIG9mZnNldCwgbGltaXRZKTtcbiAgICBjLmxpbmVUbyh3IC0gcGFkZGluZyAtIG9mZnNldCwgbGltaXRZKTtcbiAgICBjLnN0cm9rZVN0eWxlID0gJ3JnYmEoMjU1LDAsMCwnICsgb3BhY2l0eSArICcpJztcbiAgICBjLnN0cm9rZSgpO1xuICB9XG5cbiAgcmV0dXJuIGZ1bmN0aW9uIHJlbmRlcigpIHtcbiAgICBjLmNsZWFyUmVjdCgwLCAwLCB3LCBoKTtcblxuICAgIC8vIGRldGVjdGVkIG9iamVjdFxuICAgIChmdW5jdGlvbiAoKSB7XG4gICAgICBpZiAoIWRldGVjdGVkKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgdmFyIHggPSB2aWRlb1RvT3ZlcmxheVgoZGV0ZWN0ZWQueCk7XG4gICAgICB2YXIgeSA9IHZpZGVvVG9PdmVybGF5WShkZXRlY3RlZC55KTtcblxuICAgICAgYy5iZWdpblBhdGgoKTtcbiAgICAgIGMubW92ZVRvKHgsIDApO1xuICAgICAgYy5saW5lVG8oeCwgb3ZlcmxheUNhbnZhcy5oZWlnaHQpO1xuICAgICAgYy5zdHJva2VTdHlsZSA9ICdyZ2JhKDI1NSwwLDAsMSknO1xuICAgICAgYy5zdHJva2UoKTtcblxuICAgICAgYy5iZWdpblBhdGgoKTtcbiAgICAgIGMubW92ZVRvKDAsIHkpO1xuICAgICAgYy5saW5lVG8ob3ZlcmxheUNhbnZhcy53aWR0aCwgeSk7XG4gICAgICBjLnN0cm9rZVN0eWxlID0gJ3JnYmEoMjU1LDAsMCwxKSc7XG4gICAgICBjLnN0cm9rZSgpO1xuICAgIH0pKCk7XG5cbiAgICAvLyB4UElEXG4gICAgKGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBwaWQgPSB4UElELnBpZCgpO1xuICAgICAgdmFyIGZvbnRTaXplID0gMTQ7XG4gICAgICB2YXIgYmFycyA9IFtcbiAgICAgICAge2xhYmVsOiAncCcsIHZhbDogcGlkLnAsIGNvbG9yOiAnMjU1LDAsMCd9LFxuICAgICAgICB7bGFiZWw6ICdpJywgdmFsOiBwaWQuaSwgY29sb3I6ICcwLDI1NSwwJ30sXG4gICAgICAgIHtsYWJlbDogJ2QnLCB2YWw6IHBpZC5kLCBjb2xvcjogJzAsMCwyNTUnfSxcbiAgICAgICAge2xhYmVsOiAncGlkJywgdmFsOiBwaWQuc3VtLCBjb2xvcjogJzI1NSwyNTUsMjU1J31cbiAgICAgIF07XG4gICAgICB2YXIgYmggPSAxMDtcbiAgICAgIHZhciB5byA9IGggLyAyIC0gKChiaCArIGZvbnRTaXplICsgcGFkZGluZykgKiBiYXJzLmxlbmd0aCkgLyAyO1xuXG4gICAgICBiYXJzLmZvckVhY2goZnVuY3Rpb24gKGJhciwgaSkge1xuICAgICAgICB2YXIgeSA9IHlvICsgaSAqIChiaCArIGZvbnRTaXplICsgcGFkZGluZyk7XG4gICAgICAgIHZhciBidyA9IE1hdGguYWJzKGJhci52YWwgKiB3IC8gMik7XG4gICAgICAgIHZhciB4ID0gdyAvIDI7XG4gICAgICAgIGlmIChiYXIudmFsID4gMCkge1xuICAgICAgICAgIHggLT0gYnc7XG4gICAgICAgIH1cbiAgICAgICAgYy5maWxsU3R5bGUgPSAncmdiYSgnICsgYmFyLmNvbG9yICsgJywnICsgb3BhY2l0eSAqIDIgKyAnKSc7XG4gICAgICAgIGMuZmlsbFJlY3QoeCwgeSwgYncsIGJoKTtcblxuICAgICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKDI1NSwyNTUsMjU1LCcgKyBvcGFjaXR5ICsgJyknO1xuICAgICAgICBjLmZvbnQgPSBmb250U2l6ZSArICdweCBBcmlhbCc7XG4gICAgICAgIGMuZmlsbFRleHQoYmFyLmxhYmVsLCB3IC8gMiwgeSAtIHBhZGRpbmcpO1xuICAgICAgfSk7XG5cbiAgICB9KSgpO1xuXG4gICAgcmVuZGVySGlzdG9ncmFtcyhbXG4gICAgICB7bGFiZWw6ICd2aWRlbycsIHZhbHVlczogdmlkZW9IaXN0b2dyYW0udmFsdWVzKCksIGxpbWl0OiAxMDAwIC8gMzB9LFxuICAgICAge2xhYmVsOiAnbmF2ZGF0YScsIHZhbHVlczogbmF2ZGF0YUhpc3RvZ3JhbS52YWx1ZXMoKSwgbGltaXQ6IDEwMDAgLyAxNX1cbiAgICBdKTtcblxuICAgIC8vIGJhdHRlcnkgbWV0ZXJcbiAgICAoZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIHZhbHVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdmFsdWUgPSBsYXN0TmF2ZGF0YS5kZW1vLmJhdHRlcnlQZXJjZW50YWdlO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHZhbHVlID0gMDtcbiAgICAgIH1cbiAgICAgIHZhciBmdWxsV2lkdGggPSA3MDtcbiAgICAgIHZhciBmdWxsSGVpZ2h0ID0gMjQ7XG4gICAgICB2YXIgZm9udFNpemUgPSAxNDtcbiAgICAgIHZhciB3aWR0aCA9IChmdWxsV2lkdGggLSAyKSAqIHZhbHVlIC8gMTAwO1xuICAgICAgdmFyIGxhYmVsID0gdmFsdWUgKyAnICUnO1xuICAgICAgdmFyIHggPSB3IC0gZnVsbFdpZHRoIC0gcGFkZGluZztcbiAgICAgIHZhciB5ID0gcGFkZGluZztcblxuICAgICAgYy5maWxsU3R5bGUgPSAncmdiYSgyNTUsMjU1LDI1NSwnICsgb3BhY2l0eSArICcpJztcbiAgICAgIGMuZmlsbFJlY3QoeCwgeSwgZnVsbFdpZHRoLCBmdWxsSGVpZ2h0KTtcbiAgICAgIGlmICh2YWx1ZSA8IDMwKSB7XG4gICAgICAgIGMuZmlsbFN0eWxlID0gJ3JnYmEoMjU1LDAsMCwnICsgb3BhY2l0eSArICcpJztcbiAgICAgIH0gZWxzZSBpZiAodmFsdWUgPCA1MCkge1xuICAgICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKDI1NSwyNTUsMCwnICsgb3BhY2l0eSArICcpJztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGMuZmlsbFN0eWxlID0gJ3JnYmEoMCwyNTUsMCwnICsgb3BhY2l0eSArICcpJztcbiAgICAgIH1cbiAgICAgIGMuZmlsbFJlY3QoeCArIDEsIHkgKyAxLCB3aWR0aCwgZnVsbEhlaWdodCAtIDIpO1xuXG4gICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKDAsMCwwLCcgKyBvcGFjaXR5ICsgJyknO1xuICAgICAgYy5mb250ID0gZm9udFNpemUgKyAncHggQXJpYWwnO1xuICAgICAgdmFyIGxhYmVsV2lkdGggPSBjLm1lYXN1cmVUZXh0KGxhYmVsKS53aWR0aDtcbiAgICAgIGMuZmlsbFRleHQobGFiZWwsIHggKyAoZnVsbFdpZHRoIC8gMikgLSAobGFiZWxXaWR0aCAvIDIpLCB5ICsgKGZ1bGxIZWlnaHQgLyAyKSArIChmb250U2l6ZSAvIDIpIC0gMSk7XG4gICAgfSkoKTtcblxuICAgIC8vIGNvbG9yIHBpY2tlclxuICAgIChmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgeCA9IHBhZGRpbmc7XG4gICAgICB2YXIgeSA9IHBhZGRpbmc7XG4gICAgICB2YXIgc2l6ZSA9IDUwO1xuICAgICAgYy5maWxsU3R5bGUgPSAncmdiYSgyNTUsMjU1LDI1NSwnICsgb3BhY2l0eSArICcpJztcbiAgICAgIGMuZmlsbFJlY3QoeCwgeSwgc2l6ZSwgc2l6ZSk7XG5cbiAgICAgIGlmIChwaWNrZWRDb2xvcikge1xuICAgICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKCcgKyBwaWNrZWRDb2xvclswXSArICcsJyArIHBpY2tlZENvbG9yWzFdICsgJywnICsgcGlja2VkQ29sb3JbMl0gKyAnLDEpJztcbiAgICAgICAgYy5maWxsUmVjdCh4ICsgMSwgeSArIDEsIHNpemUgLSAyLCBzaXplIC0gMik7XG4gICAgICB9XG4gICAgfSkoKTtcbiAgfTtcbn1cblxuLy8gS2VlcCB2aWRlbyBtYXhpbWl6ZWQgd2l0aGluIGJyb3dzZXIgd2luZG93IHdoaWxlIGtlZXBpbmcgdGhlIGFzcGVjdCByYXRpb1xuLy8gaW50YWN0Llxud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3Jlc2l6ZScsIG1heGltaXplVmlkZW8pO1xuZnVuY3Rpb24gbWF4aW1pemVWaWRlbygpIHtcbiAgdmFyIHdpZHRoLCBoZWlnaHQ7XG4gIHZhciB3aW5kb3dSYXRpbyA9IHdpbmRvdy5pbm5lcldpZHRoIC8gd2luZG93LmlubmVySGVpZ2h0O1xuICBpZiAod2luZG93UmF0aW8gPiBhc3BlY3RSYXRpbykge1xuICAgIGhlaWdodCA9IHdpbmRvdy5pbm5lckhlaWdodDtcbiAgICB3aWR0aCA9IGhlaWdodCAqIGFzcGVjdFJhdGlvO1xuICB9IGVsc2Uge1xuICAgIHdpZHRoID0gd2luZG93LmlubmVyV2lkdGg7XG4gICAgaGVpZ2h0ID0gd2lkdGggLyBhc3BlY3RSYXRpbztcbiAgfVxuICBbdmlkZW9DYW52YXMsIG92ZXJsYXlDYW52YXNdLmZvckVhY2goZnVuY3Rpb24gKGNhbnZhcykge1xuICAgIGNhbnZhcy5zdHlsZS53aWR0aCA9IHdpZHRoICsgJ3B4JztcbiAgICBjYW52YXMuc3R5bGUuaGVpZ2h0ID0gaGVpZ2h0ICsgJ3B4JztcbiAgICBjYW52YXMuc3R5bGUubWFyZ2luVG9wID0gKCh3aW5kb3cuaW5uZXJIZWlnaHQgLSBoZWlnaHQpIC8gMikgKyAncHgnO1xuICAgIGNhbnZhcy5zdHlsZS5tYXJnaW5MZWZ0ID0gKCh3aW5kb3cuaW5uZXJXaWR0aCAtIHdpZHRoKSAvIDIpICsgJ3B4JztcbiAgfSk7XG59XG5cbm92ZXJsYXlDYW52YXMuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgdmFyIHggPSBvdmVybGF5VG9WaWRlb1goZXZlbnQub2Zmc2V0WCk7XG4gIHZhciB5ID0gb3ZlcmxheVRvVmlkZW9ZKGV2ZW50Lm9mZnNldFkpO1xuICBwaWNrZWRDb2xvciA9IHBpY2tlZENvbG9yIHx8IG5ldyBVaW50OEFycmF5KDQpO1xuICBucy5nZXRJbWFnZURhdGEocGlja2VkQ29sb3IsIHgsIHZpZGVvQ2FudmFzLmhlaWdodCAtIHksIDEsIDEpO1xufSk7XG5cbmZ1bmN0aW9uIG92ZXJsYXlUb1ZpZGVvWCh4KSB7XG4gIHJldHVybiBNYXRoLnJvdW5kKCh4IC8gcGFyc2VGbG9hdCh2aWRlb0NhbnZhcy5zdHlsZS53aWR0aCkpICogdmlkZW9DYW52YXMud2lkdGgpO1xufVxuXG5mdW5jdGlvbiBvdmVybGF5VG9WaWRlb1koeSkge1xuICByZXR1cm4gTWF0aC5yb3VuZCgoeSAvIHBhcnNlRmxvYXQodmlkZW9DYW52YXMuc3R5bGUuaGVpZ2h0KSkgKiB2aWRlb0NhbnZhcy5oZWlnaHQpO1xufVxuXG5mdW5jdGlvbiB2aWRlb1RvT3ZlcmxheVgoeCkge1xuICByZXR1cm4gTWF0aC5yb3VuZCh4IC8gdmlkZW9DYW52YXMud2lkdGggKiBvdmVybGF5Q2FudmFzLndpZHRoKTtcbn1cblxuZnVuY3Rpb24gdmlkZW9Ub092ZXJsYXlZKHkpIHtcbiAgcmV0dXJuIE1hdGgucm91bmQoeSAvIHZpZGVvQ2FudmFzLmhlaWdodCAqIG92ZXJsYXlDYW52YXMuaGVpZ2h0KTtcbn1cblxuZnVuY3Rpb24gc2V0U3RhdGUodmFsKSB7XG4gIGNvbnNvbGUubG9nKCduZXcgc3RhdGU6ICcgKyB2YWwpO1xuICBzdGF0ZSA9IHZhbDtcbn1cblxudmFyIGZsaWdodEJ1dHRvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmbGlnaHQnKTtcbmZsaWdodEJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMudGV4dENvbnRlbnQgPT09ICdTdGFydCcpIHtcbiAgICBzZXRTdGF0ZSgndGFrZW9mZicpO1xuICAgIGNsaWVudC5vbignYWx0aXR1ZGVDaGFuZ2UnLCBmdW5jdGlvbiAodikge1xuICAgICAgaWYgKHYgPCAwLjEpIHtcbiAgICAgICAgdGhpcy51cCgwLjAyKTtcbiAgICAgIH0gZWxzZSBpZiAodiA8IDAuMykge1xuICAgICAgICB0aGlzLmRvd24oMCk7XG4gICAgICB9IGVsc2UgaWYgKHYgPiAwLjYpIHtcbiAgICAgICAgdGhpcy5kb3duKDAuMyk7XG4gICAgICB9IGVsc2UgaWYgKHYgPiAwLjUpIHtcbiAgICAgICAgdGhpcy5kb3duKDAuMSk7XG4gICAgICB9IGVsc2UgaWYgKHYgPiAwLjQpIHtcbiAgICAgICAgdGhpcy5kb3duKDAuMDUpO1xuICAgICAgfVxuICAgIH1cbiAgKTtcbiAgY2xpZW50LnRha2VvZmYoZnVuY3Rpb24gKCkge1xuICAgIHNldFN0YXRlKCdmb2xsb3cnKTtcbiAgICBjbGllbnQuZG93bigwLjEpO1xuICB9KTtcbiAgdGhpcy50ZXh0Q29udGVudCA9ICdTdG9wJztcbn1cbmVsc2VcbntcbiAgc2V0U3RhdGUoJ2xhbmQnKTtcbiAgY2xpZW50LmxhbmQoZnVuY3Rpb24gKCkge1xuICAgIHNldFN0YXRlKCdncm91bmQnKTtcbiAgfSk7XG4gIHRoaXMudGV4dENvbnRlbnQgPSAnU3RhcnQnO1xufVxufSlcbjtcbiIsIlwidXNlIHN0cmljdFwiO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFBJRDtcbmZ1bmN0aW9uIFBJRChvcHRpb25zKSB7XG4gIHRoaXMuX3BHYWluID0gb3B0aW9ucy5wR2FpbiB8fCAwO1xuICB0aGlzLl9pR2FpbiA9IG9wdGlvbnMuaUdhaW4gfHwgMDtcbiAgdGhpcy5fZEdhaW4gPSBvcHRpb25zLmRHYWluIHx8IDA7XG4gIHRoaXMuX21pbiA9IG9wdGlvbnMubWluIHx8IC0xO1xuICB0aGlzLl9tYXggPSBvcHRpb25zLm1heCB8fCAxO1xuICB0aGlzLl96ZXJvID0gb3B0aW9ucy56ZXJvIHx8IDA7XG5cbiAgdGhpcy5fcCA9IDA7XG4gIHRoaXMuX2kgPSAwO1xuICB0aGlzLl9kID0gMDtcbiAgdGhpcy5fc3VtID0gMDtcblxuICB0aGlzLl90YXJnZXQgPSAwO1xuICB0aGlzLl9zdW1FcnIgPSAwO1xuICB0aGlzLl9sYXN0RXJyID0gMDtcbiAgdGhpcy5fbGFzdFRpbWUgPSBudWxsO1xuXG4gIHRoaXMudGFyZ2V0KDApO1xufVxuXG5QSUQucHJvdG90eXBlLnRhcmdldCA9IGZ1bmN0aW9uKHZhbCkge1xuICBpZiAodmFsID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gdGhpcy5fdGFyZ2V0O1xuICB9XG4gIHRoaXMuX3N1bUVyciA9IDA7XG4gIHRoaXMuX2xhc3RFcnIgPSAwO1xuICB0aGlzLl9sYXN0VGltZSA9IG51bGw7XG4gIHRoaXMuX3N1bSA9IHRoaXMuX3AgPSB0aGlzLl9pID0gdGhpcy5fZCA9IHRoaXMuX3plcm87XG4gIHRoaXMuX3RhcmdldCA9IHZhbDtcbiAgcmV0dXJuIHRoaXMuX3RhcmdldDtcbn07XG5cblBJRC5wcm90b3R5cGUudXBkYXRlID0gZnVuY3Rpb24odmFsKSB7XG4gIHZhciBub3cgPSBEYXRlLm5vdygpO1xuICB2YXIgZHQgPSAwO1xuICBpZiAodGhpcy5fbGFzdFRpbWUgIT09IG51bGwpIHtcbiAgICBkdCA9IChub3cgLSB0aGlzLl9sYXN0VGltZSkgLyAxMDAwO1xuICB9XG4gIHRoaXMuX2xhc3RUaW1lID0gbm93O1xuXG4gIHZhciBlcnIgPSB0aGlzLl90YXJnZXQgLSB2YWw7XG4gIHZhciBkRXJyID0gKGVyciAtIHRoaXMuX2xhc3RFcnIpKmR0O1xuICB0aGlzLl9zdW1FcnIgKz0gZXJyICogZHQ7XG4gIHRoaXMuX2xhc3RFcnIgPSBlcnI7XG5cbiAgdGhpcy5fcCA9IHRoaXMuX3BHYWluKmVycjtcbiAgdGhpcy5faSA9IHRoaXMuX2lHYWluKnRoaXMuX3N1bUVycjtcbiAgdGhpcy5fZCA9IHRoaXMuX2RHYWluKmRFcnI7XG4gIHRoaXMuX3N1bSA9IHRoaXMuX3ArdGhpcy5faSt0aGlzLl9kO1xuICBpZiAodGhpcy5fc3VtIDwgdGhpcy5fbWluKSB7XG4gICAgdGhpcy5fc3VtID0gdGhpcy5fbWluO1xuICB9IGVsc2UgaWYgKHRoaXMuX3N1bSA+IHRoaXMuX21heCkge1xuICAgIHRoaXMuX3N1bSA9IHRoaXMuX21heDtcbiAgfVxufTtcblxuUElELnByb3RvdHlwZS5waWQgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHtwOiB0aGlzLl9wLCBpOiB0aGlzLl9pLCBkOiB0aGlzLl9kLCBzdW06IHRoaXMuX3N1bX07XG59O1xuIiwiLyogZ2xvYmFsIHdpbmRvdywgV2ViU29ja2V0ICovIFxuXCJ1c2Ugc3RyaWN0XCI7XG5tb2R1bGUuZXhwb3J0cyA9IFdzQ2xpZW50O1xuZnVuY3Rpb24gV3NDbGllbnQoKSB7XG4gIHRoaXMuX2Nvbm4gPSBudWxsO1xuICB0aGlzLl9jb25uZWN0ZWQgPSBmYWxzZTtcbiAgdGhpcy5fcXVldWUgPSBbXTtcbiAgdGhpcy5fbGlzdGVuZXJzID0ge307XG4gIHRoaXMuX3Rha2VvZmZDYnMgPSBbXTtcbiAgdGhpcy5fbGFuZENicyA9IFtdO1xuICB0aGlzLl9jb25uZWN0KCk7XG59XG5cbldzQ2xpZW50LnByb3RvdHlwZS5fY29ubmVjdCA9IGZ1bmN0aW9uKCkge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHNlbGYuX2Nvbm4gPSBuZXcgV2ViU29ja2V0KCd3czovLycrd2luZG93LmxvY2F0aW9uLmhvc3QpO1xuICBzZWxmLl9jb25uLm9ub3BlbiA9IGZ1bmN0aW9uKCkge1xuICAgIHNlbGYuX2Nvbm5lY3RlZCA9IHRydWU7XG4gICAgc2VsZi5fcXVldWUuZm9yRWFjaChmdW5jdGlvbihtc2cpIHtcbiAgICAgIHNlbGYuX2Nvbm4uc2VuZChtc2cpO1xuICAgIH0pO1xuICAgIHNlbGYuX3F1ZXVlID0gW107XG5cbiAgICBzZWxmLl9jb25uLm9ubWVzc2FnZSA9IGZ1bmN0aW9uKG1zZykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgbXNnID0gSlNPTi5wYXJzZShtc2cuZGF0YSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB2YXIga2luZCA9IG1zZy5zaGlmdCgpO1xuICAgICAgc3dpdGNoIChraW5kKSB7XG4gICAgICAgIGNhc2UgJ3Rha2VvZmYnOlxuICAgICAgICAgIHNlbGYuX3Rha2VvZmZDYnMuZm9yRWFjaChmdW5jdGlvbihjYikge1xuICAgICAgICAgICAgY2IoKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBzZWxmLl90YWtlb2ZmQ2JzID0gW107XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ2xhbmQnOlxuICAgICAgICAgIHNlbGYuX2xhbmRDYnMuZm9yRWFjaChmdW5jdGlvbihjYikge1xuICAgICAgICAgICAgY2IoKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBzZWxmLl9sYW5kQ2JzID0gW107XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ29uJzpcbiAgICAgICAgICB2YXIgZXZlbnQgPSBtc2cuc2hpZnQoKTtcbiAgICAgICAgICBzZWxmLl9saXN0ZW5lcnNbZXZlbnRdLmZvckVhY2goZnVuY3Rpb24oY2IpIHtcbiAgICAgICAgICAgIGNiLmFwcGx5KHNlbGYsIG1zZyk7XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgY29uc29sZS5lcnJvcigndW5rbm93biBtZXNzYWdlOiAnK2tpbmQpO1xuICAgICAgfVxuICAgIH07XG4gIH07XG5cbn07XG5cbldzQ2xpZW50LnByb3RvdHlwZS5fc2VuZCA9IGZ1bmN0aW9uKG1zZykge1xuICBtc2cgPSBKU09OLnN0cmluZ2lmeShtc2cpO1xuICBpZiAoIXRoaXMuX2Nvbm5lY3RlZCkge1xuICAgIHRoaXMuX3F1ZXVlLnB1c2gobXNnKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdGhpcy5fY29ubi5zZW5kKG1zZyk7XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUub24gPSBmdW5jdGlvbihldmVudCwgY2IpIHtcbiAgdmFyIGNicyA9IHRoaXMuX2xpc3RlbmVyc1tldmVudF0gPSB0aGlzLl9saXN0ZW5lcnNbZXZlbnRdIHx8IFtdO1xuICBjYnMucHVzaChjYik7XG4gIGlmIChjYnMubGVuZ3RoID09PSAxKSB7XG4gICAgdGhpcy5fc2VuZChbJ29uJywgZXZlbnRdKTtcbiAgfVxufTtcblxuV3NDbGllbnQucHJvdG90eXBlLnRha2VvZmYgPSBmdW5jdGlvbihjYikge1xuICB0aGlzLl9zZW5kKFsndGFrZW9mZiddKTtcbiAgaWYgKGNiKSB7XG4gICAgdGhpcy5fdGFrZW9mZkNicy5wdXNoKGNiKTtcbiAgfVxufTtcblxuV3NDbGllbnQucHJvdG90eXBlLmxhbmQgPSBmdW5jdGlvbihjYikge1xuICB0aGlzLl9zZW5kKFsnbGFuZCddKTtcbiAgaWYgKGNiKSB7XG4gICAgdGhpcy5fbGFuZENicy5wdXNoKGNiKTtcbiAgfVxufTtcblxuV3NDbGllbnQucHJvdG90eXBlLnJpZ2h0ID0gZnVuY3Rpb24odmFsKSB7XG4gIHRoaXMuX3NlbmQoWydyaWdodCcsIHZhbF0pO1xufTtcblxuV3NDbGllbnQucHJvdG90eXBlLmNsb2Nrd2lzZSA9IGZ1bmN0aW9uKHZhbCkge1xuICB0aGlzLl9zZW5kKFsnY2xvY2t3aXNlJywgdmFsXSk7XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUuZG93biA9IGZ1bmN0aW9uKHZhbCkge1xuICB0aGlzLl9zZW5kKFsnZG93bicsIHZhbF0pO1xufTtcblxuV3NDbGllbnQucHJvdG90eXBlLnVwID0gZnVuY3Rpb24odmFsKSB7XG4gIHRoaXMuX3NlbmQoWyd1cCcsIHZhbF0pO1xufTtcblxuV3NDbGllbnQucHJvdG90eXBlLmZyb250ID0gZnVuY3Rpb24odmFsKSB7XG4gIHRoaXMuX3NlbmQoWydmcm9udCcsIHZhbF0pO1xufTtcblxuV3NDbGllbnQucHJvdG90eXBlLmNsb2Nrd2lzZSA9IGZ1bmN0aW9uKHZhbCkge1xuICB0aGlzLl9zZW5kKFsnY2xvY2t3aXNlJywgdmFsXSk7XG59O1xuXG5cbldzQ2xpZW50LnByb3RvdHlwZS5zdG9wID0gZnVuY3Rpb24oKSB7XG4gIHRoaXMuX3NlbmQoWydzdG9wJ10pO1xufTtcbiJdfQ==
