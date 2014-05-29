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
var detect = detector({maxDiff: 0.05});
var lastNavdata;
var pickedColor;
var detected;
var xPID = new PID({pGain: 0.1, iGain: 0, dGain: 0});
var client = new WsClient();
var state;
setState('ground');

// main gets this party started.
(function main() {
  maximizeVideo();
  renderLoop();
  ns.onNextFrame(frameLoop);
  client.on('navdata', function(data) {
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

  return function detect() {
    ns.getImageData(b);

    var count = 0;
    var xSum = 0;
    var ySum = 0;
    for (var x = 1; x < w-1; x++) {
      for (var y = 1; y < h-1; y++) {
        var match = true;
          for(var xj = -1; xj <= 1 && match; xj++) {
            for(var yj = -1; yj <= 1 && match; yj++) {
              var o = (x + xj)*4+(h-(y+yj))*w*4;
              for (var i = 0; i < pickedColor.length && match; i++) {
                var diffPercent = Math.abs(b[o+i]-pickedColor[i]) / 255;
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
    detected = {x: xSum / count, y: ySum /count};
    var xVal = (detected.x - w / 2)/(w / 2);
    xPID.update(xVal);

    if (state === 'follow') {
      if(xSum < 25) {
        client.right(0.3);
        client.front(0.0);
      } else {
        client.right(-xPID.pid().sum);
        client.front(1.0);
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
    histograms.forEach(function(h) {
      renderHistogram(h.label, h.values, h.limit, offset);
      offset += h.values.length+spacing;
    });
  }

  function renderHistogram(label, values, limit, offset) {
    // offset is number of pixels from right to offset the histogram.
    offset = offset || 0;
    var fontSize = 20;

    c.fillStyle = 'rgba(255,255,255,'+opacity+')';
    c.font = fontSize+'px Arial';
    var labelWidth = c.measureText(label).width;
    c.fillText(label, w-(labelWidth/2)-(values.length/2)-padding-offset, h-padding);

    for (var i = 0; i < values.length; i++) {
      var x = w-i-padding-offset;
      c.beginPath();
      c.moveTo(x, h-fontSize-padding);
      c.lineTo(x, h-values[i]-fontSize-padding);
      c.strokeStyle = 'rgba(255,255,255,'+opacity+')';
      c.stroke();
    }

    var limitY = h-fontSize-padding-limit;
    c.beginPath();
    c.moveTo(w-padding-values.length-offset, limitY);
    c.lineTo(w-padding-offset, limitY);
    c.strokeStyle = 'rgba(255,0,0,'+opacity+')';
    c.stroke();
  }

  return function render() {
    c.clearRect(0, 0, w, h);

    // detected object
    (function() {
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
    (function() {
      var pid = xPID.pid();
      var fontSize = 14;
      var bars = [
        {label: 'p', val: pid.p, color: '255,0,0'},
        {label: 'i', val: pid.i, color: '0,255,0'},
        {label: 'd', val: pid.d, color: '0,0,255'},
        {label: 'pid', val: pid.sum, color: '255,255,255'}
      ];
      var bh = 10;
      var yo = h /2 - ((bh + fontSize + padding) * bars.length) / 2;

      bars.forEach(function(bar, i) {
        var y = yo + i * (bh + fontSize + padding);
        var bw = Math.abs(bar.val * w / 2);
        var x = w / 2;
        if (bar.val > 0) {
          x -= bw;
        }
        c.fillStyle = 'rgba('+bar.color+','+opacity*2+')';
        c.fillRect(x, y, bw, bh); 

        c.fillStyle = 'rgba(255,255,255,'+opacity+')';
        c.font = fontSize+'px Arial';
        c.fillText(bar.label, w/2, y-padding);
      });

    })();

    renderHistograms([
      {label: 'video', values: videoHistogram.values(), limit: 1000/30},
      {label: 'navdata', values: navdataHistogram.values(), limit: 1000/15}
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
      var x = w-fullWidth-padding;
      var y = padding;

      c.fillStyle = 'rgba(255,255,255,'+opacity+')';
      c.fillRect(x, y, fullWidth, fullHeight); 
      if (value < 30) {
        c.fillStyle = 'rgba(255,0,0,'+opacity+')';
      } else if (value < 50) {
        c.fillStyle = 'rgba(255,255,0,'+opacity+')';
      } else {
        c.fillStyle = 'rgba(0,255,0,'+opacity+')';
      }
      c.fillRect(x+1, y+1, width, fullHeight-2); 

      c.fillStyle = 'rgba(0,0,0,'+opacity+')';
      c.font = fontSize+'px Arial';
      var labelWidth = c.measureText(label).width;
      c.fillText(label, x+(fullWidth/2)-(labelWidth/2), y+(fullHeight/2)+(fontSize/2)-1);
    })();

    // color picker
    (function () {
      var x = padding;
      var y = padding;
      var size = 50;
      c.fillStyle = 'rgba(255,255,255,'+opacity+')';
      c.fillRect(x, y, size, size); 

      if (pickedColor) {
        c.fillStyle = 'rgba('+pickedColor[0]+','+pickedColor[1]+','+pickedColor[2]+',1)';
        c.fillRect(x+1, y+1, size-2, size-2); 
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
    width = height*aspectRatio;
  } else {
    width = window.innerWidth;
    height = width/aspectRatio;
  }
  [videoCanvas, overlayCanvas].forEach(function(canvas) {
    canvas.style.width = width+'px';
    canvas.style.height = height+'px';
    canvas.style.marginTop = ((window.innerHeight-height)/2)+'px';
    canvas.style.marginLeft = ((window.innerWidth-width)/2)+'px';
  });
}

overlayCanvas.addEventListener('click', function(event) {
  var x = overlayToVideoX(event.offsetX);
  var y = overlayToVideoY(event.offsetY);
  pickedColor = pickedColor || new Uint8Array(4);
  ns.getImageData(pickedColor, x, videoCanvas.height-y, 1, 1);
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
  console.log('new state: '+val);
  state = val;
}

var flightButton = document.getElementById('flight');
flightButton.addEventListener('click', function() {
  if (this.textContent === 'Start') {
    setState('takeoff');
    client.on('altitudeChange', function(v){
      if(v < 0.3) {
        this.down(0);
      }
    });
    client.takeoff(function() {
      setState('follow');
      client.down(1.0);
      client.front(1.0);
    });
    this.textContent = 'Stop';
  } else {
    setState('land');
    client.land(function() {
      setState('ground');
    });
    this.textContent = 'Start';
  }
});

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


WsClient.prototype.down = function(val) {
  this._send(['down', val]);
};

WsClient.prototype.up = function(val) {
  this._send(['up', val]);
};

WsClient.prototype.front = function(val) {
  this._send(['front', val]);
};


WsClient.prototype.stop = function() {
  this._send(['stop']);
};

},{}]},{},[2])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlcyI6WyIvaG9tZS9jaHVjay9kZXYvd29ya3NwYWNlL2FyZHJvbmUtZm9vdGJhbGwvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsIi9ob21lL2NodWNrL2Rldi93b3Jrc3BhY2UvYXJkcm9uZS1mb290YmFsbC9mcm9udGVuZC9qcy9oaXN0b2dyYW0uanMiLCIvaG9tZS9jaHVjay9kZXYvd29ya3NwYWNlL2FyZHJvbmUtZm9vdGJhbGwvZnJvbnRlbmQvanMvbWFpbi5qcyIsIi9ob21lL2NodWNrL2Rldi93b3Jrc3BhY2UvYXJkcm9uZS1mb290YmFsbC9mcm9udGVuZC9qcy9waWQuanMiLCIvaG9tZS9jaHVjay9kZXYvd29ya3NwYWNlL2FyZHJvbmUtZm9vdGJhbGwvZnJvbnRlbmQvanMvd3NfY2xpZW50LmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNVVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9EQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3Rocm93IG5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIil9dmFyIGY9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGYuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sZixmLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsIlwidXNlIHN0cmljdFwiO1xubW9kdWxlLmV4cG9ydHMgPSBIaXN0b2dyYW07XG5mdW5jdGlvbiBIaXN0b2dyYW0oaGlzdG9ncmFtU2l6ZSkge1xuICB0aGlzLl9wcmV2ID0gRGF0ZS5ub3coKTtcbiAgdGhpcy5faGlzdG9ncmFtID0gW107XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgaGlzdG9ncmFtU2l6ZTsgaSsrKSB7XG4gICAgdGhpcy5faGlzdG9ncmFtLnB1c2goMCk7XG4gIH1cbn1cblxuSGlzdG9ncmFtLnByb3RvdHlwZS50aWNrID0gZnVuY3Rpb24oKSB7XG4gIHZhciBsYXRlbmN5ID0gRGF0ZS5ub3coKSAtIHRoaXMuX3ByZXY7XG4gIHRoaXMuX2hpc3RvZ3JhbS5wdXNoKGxhdGVuY3kpO1xuICB0aGlzLl9oaXN0b2dyYW0uc2hpZnQoKTtcbiAgdGhpcy5fcHJldiA9IERhdGUubm93KCk7XG59O1xuXG5IaXN0b2dyYW0ucHJvdG90eXBlLnZhbHVlcyA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5faGlzdG9ncmFtO1xufTtcbiIsIi8qIGdsb2JhbCBkb2N1bWVudCwgTm9kZWNvcHRlclN0cmVhbSwgd2luZG93LCByZXF1ZXN0QW5pbWF0aW9uRnJhbWUsIFVpbnQ4QXJyYXkgKi8gXG5cInVzZSBzdHJpY3RcIjtcbnZhciBIaXN0b2dyYW0gPSByZXF1aXJlKCcuL2hpc3RvZ3JhbScpO1xudmFyIFdzQ2xpZW50ID0gcmVxdWlyZSgnLi93c19jbGllbnQnKTtcbnZhciBQSUQgPSByZXF1aXJlKCcuL3BpZCcpO1xuXG52YXIgdmlkZW9EaXYgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndmlkZW8nKTtcbnZhciBucyA9IG5ldyBOb2RlY29wdGVyU3RyZWFtKHZpZGVvRGl2LCB7cG9ydDogMzAwMX0pO1xudmFyIHZpZGVvQ2FudmFzID0gdmlkZW9EaXYucXVlcnlTZWxlY3RvcignY2FudmFzJyk7XG52YXIgYXNwZWN0UmF0aW8gPSB2aWRlb0NhbnZhcy53aWR0aCAvIHZpZGVvQ2FudmFzLmhlaWdodDtcbnZhciBvdmVybGF5Q2FudmFzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ292ZXJsYXknKTtcbnZhciBvdmVybGF5Q29udGV4dCA9IG92ZXJsYXlDYW52YXMuZ2V0Q29udGV4dCgnMmQnKTtcbnZhciBmcmFtZUJ1ZmZlciA9IG5ldyBVaW50OEFycmF5KHZpZGVvQ2FudmFzLndpZHRoICogdmlkZW9DYW52YXMuaGVpZ2h0ICogNCk7XG52YXIgdmlkZW9IaXN0b2dyYW0gPSBuZXcgSGlzdG9ncmFtKDIwMCk7XG52YXIgbmF2ZGF0YUhpc3RvZ3JhbSA9IG5ldyBIaXN0b2dyYW0oMjAwKTtcbnZhciByZW5kZXIgPSByZW5kZXJlcigpO1xudmFyIGRldGVjdCA9IGRldGVjdG9yKHttYXhEaWZmOiAwLjA1fSk7XG52YXIgbGFzdE5hdmRhdGE7XG52YXIgcGlja2VkQ29sb3I7XG52YXIgZGV0ZWN0ZWQ7XG52YXIgeFBJRCA9IG5ldyBQSUQoe3BHYWluOiAwLjEsIGlHYWluOiAwLCBkR2FpbjogMH0pO1xudmFyIGNsaWVudCA9IG5ldyBXc0NsaWVudCgpO1xudmFyIHN0YXRlO1xuc2V0U3RhdGUoJ2dyb3VuZCcpO1xuXG4vLyBtYWluIGdldHMgdGhpcyBwYXJ0eSBzdGFydGVkLlxuKGZ1bmN0aW9uIG1haW4oKSB7XG4gIG1heGltaXplVmlkZW8oKTtcbiAgcmVuZGVyTG9vcCgpO1xuICBucy5vbk5leHRGcmFtZShmcmFtZUxvb3ApO1xuICBjbGllbnQub24oJ25hdmRhdGEnLCBmdW5jdGlvbihkYXRhKSB7XG4gICAgbGFzdE5hdmRhdGEgPSBkYXRhO1xuICAgIG5hdmRhdGFIaXN0b2dyYW0udGljaygpO1xuICB9KTtcbn0pKCk7XG5cbi8vIHJlbmRlckxvb3AgZHJpdmVzIHRoZSByZW5kZXJlci5cbmZ1bmN0aW9uIHJlbmRlckxvb3AoKSB7XG4gIHJlbmRlcigpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUocmVuZGVyTG9vcCk7XG59XG5cbi8vIGZyYW1lTG9vcCBhbmFseXplcyBpbmNvbWluZyB2aWRlbyBmcmFtZXMuXG5mdW5jdGlvbiBmcmFtZUxvb3AoKSB7XG4gIHZpZGVvSGlzdG9ncmFtLnRpY2soKTtcblxuICBpZiAocGlja2VkQ29sb3IpIHtcbiAgICBkZXRlY3QoKTtcbiAgfVxuXG4gIG5zLm9uTmV4dEZyYW1lKGZyYW1lTG9vcCk7XG59XG5cbi8vIGRldGVjdG9yIHJldHVybnMgYSBmdW5jdGlvbiB0aGF0IHRyaWVzIHRvIGZpbmQgYSBjb2xvcmVkIG9iamVjdCBpbiB0aGUgaW1hZ2UuXG5mdW5jdGlvbiBkZXRlY3RvcihvcHRpb25zKSB7XG4gIHZhciBtYXhEaWZmID0gb3B0aW9ucy5tYXhEaWZmO1xuICB2YXIgdyA9IHZpZGVvQ2FudmFzLndpZHRoO1xuICB2YXIgaCA9IHZpZGVvQ2FudmFzLmhlaWdodDtcbiAgdmFyIGIgPSBmcmFtZUJ1ZmZlcjtcblxuICByZXR1cm4gZnVuY3Rpb24gZGV0ZWN0KCkge1xuICAgIG5zLmdldEltYWdlRGF0YShiKTtcblxuICAgIHZhciBjb3VudCA9IDA7XG4gICAgdmFyIHhTdW0gPSAwO1xuICAgIHZhciB5U3VtID0gMDtcbiAgICBmb3IgKHZhciB4ID0gMTsgeCA8IHctMTsgeCsrKSB7XG4gICAgICBmb3IgKHZhciB5ID0gMTsgeSA8IGgtMTsgeSsrKSB7XG4gICAgICAgIHZhciBtYXRjaCA9IHRydWU7XG4gICAgICAgICAgZm9yKHZhciB4aiA9IC0xOyB4aiA8PSAxICYmIG1hdGNoOyB4aisrKSB7XG4gICAgICAgICAgICBmb3IodmFyIHlqID0gLTE7IHlqIDw9IDEgJiYgbWF0Y2g7IHlqKyspIHtcbiAgICAgICAgICAgICAgdmFyIG8gPSAoeCArIHhqKSo0KyhoLSh5K3lqKSkqdyo0O1xuICAgICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHBpY2tlZENvbG9yLmxlbmd0aCAmJiBtYXRjaDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgdmFyIGRpZmZQZXJjZW50ID0gTWF0aC5hYnMoYltvK2ldLXBpY2tlZENvbG9yW2ldKSAvIDI1NTtcbiAgICAgICAgICAgICAgICBpZiAoZGlmZlBlcmNlbnQgPiBtYXhEaWZmKSB7XG4gICAgICAgICAgICAgICAgICBtYXRjaCA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgICBjb3VudCsrO1xuICAgICAgICAgIHhTdW0gKz0geDtcbiAgICAgICAgICB5U3VtICs9IHk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgZGV0ZWN0ZWQgPSB7eDogeFN1bSAvIGNvdW50LCB5OiB5U3VtIC9jb3VudH07XG4gICAgdmFyIHhWYWwgPSAoZGV0ZWN0ZWQueCAtIHcgLyAyKS8odyAvIDIpO1xuICAgIHhQSUQudXBkYXRlKHhWYWwpO1xuXG4gICAgaWYgKHN0YXRlID09PSAnZm9sbG93Jykge1xuICAgICAgaWYoeFN1bSA8IDI1KSB7XG4gICAgICAgIGNsaWVudC5yaWdodCgwLjMpO1xuICAgICAgICBjbGllbnQuZnJvbnQoMC4wKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNsaWVudC5yaWdodCgteFBJRC5waWQoKS5zdW0pO1xuICAgICAgICBjbGllbnQuZnJvbnQoMS4wKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY2xpZW50LnN0b3AoKTtcbiAgICB9XG4gIH07XG59XG5cbi8vIHJlbmRlcmVyIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW5kZXIgdGhlIG92ZXJsYXkgY2FudmFzLiBUaGUgY29vcmRpbmF0ZVxuLy8gc3lzdGVtIGlzIHNldCB1cCBzbyB0aGF0ICgwLDApIGlzIHRoZSB0b3AgbGVmdCBvZiB0aGUgY2FudmFzLlxuZnVuY3Rpb24gcmVuZGVyZXIoKSB7XG4gIHZhciBwYWRkaW5nID0gMTA7XG4gIHZhciBzcGFjaW5nID0gMjA7XG4gIHZhciBjID0gb3ZlcmxheUNvbnRleHQ7XG4gIHZhciB3ID0gb3ZlcmxheUNhbnZhcy53aWR0aDtcbiAgdmFyIGggPSBvdmVybGF5Q2FudmFzLmhlaWdodDtcbiAgdmFyIG9wYWNpdHkgPSAwLjM7XG5cbiAgZnVuY3Rpb24gcmVuZGVySGlzdG9ncmFtcyhoaXN0b2dyYW1zKSB7XG4gICAgdmFyIG9mZnNldCA9IDA7XG4gICAgaGlzdG9ncmFtcy5mb3JFYWNoKGZ1bmN0aW9uKGgpIHtcbiAgICAgIHJlbmRlckhpc3RvZ3JhbShoLmxhYmVsLCBoLnZhbHVlcywgaC5saW1pdCwgb2Zmc2V0KTtcbiAgICAgIG9mZnNldCArPSBoLnZhbHVlcy5sZW5ndGgrc3BhY2luZztcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlbmRlckhpc3RvZ3JhbShsYWJlbCwgdmFsdWVzLCBsaW1pdCwgb2Zmc2V0KSB7XG4gICAgLy8gb2Zmc2V0IGlzIG51bWJlciBvZiBwaXhlbHMgZnJvbSByaWdodCB0byBvZmZzZXQgdGhlIGhpc3RvZ3JhbS5cbiAgICBvZmZzZXQgPSBvZmZzZXQgfHwgMDtcbiAgICB2YXIgZm9udFNpemUgPSAyMDtcblxuICAgIGMuZmlsbFN0eWxlID0gJ3JnYmEoMjU1LDI1NSwyNTUsJytvcGFjaXR5KycpJztcbiAgICBjLmZvbnQgPSBmb250U2l6ZSsncHggQXJpYWwnO1xuICAgIHZhciBsYWJlbFdpZHRoID0gYy5tZWFzdXJlVGV4dChsYWJlbCkud2lkdGg7XG4gICAgYy5maWxsVGV4dChsYWJlbCwgdy0obGFiZWxXaWR0aC8yKS0odmFsdWVzLmxlbmd0aC8yKS1wYWRkaW5nLW9mZnNldCwgaC1wYWRkaW5nKTtcblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdmFsdWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICB2YXIgeCA9IHctaS1wYWRkaW5nLW9mZnNldDtcbiAgICAgIGMuYmVnaW5QYXRoKCk7XG4gICAgICBjLm1vdmVUbyh4LCBoLWZvbnRTaXplLXBhZGRpbmcpO1xuICAgICAgYy5saW5lVG8oeCwgaC12YWx1ZXNbaV0tZm9udFNpemUtcGFkZGluZyk7XG4gICAgICBjLnN0cm9rZVN0eWxlID0gJ3JnYmEoMjU1LDI1NSwyNTUsJytvcGFjaXR5KycpJztcbiAgICAgIGMuc3Ryb2tlKCk7XG4gICAgfVxuXG4gICAgdmFyIGxpbWl0WSA9IGgtZm9udFNpemUtcGFkZGluZy1saW1pdDtcbiAgICBjLmJlZ2luUGF0aCgpO1xuICAgIGMubW92ZVRvKHctcGFkZGluZy12YWx1ZXMubGVuZ3RoLW9mZnNldCwgbGltaXRZKTtcbiAgICBjLmxpbmVUbyh3LXBhZGRpbmctb2Zmc2V0LCBsaW1pdFkpO1xuICAgIGMuc3Ryb2tlU3R5bGUgPSAncmdiYSgyNTUsMCwwLCcrb3BhY2l0eSsnKSc7XG4gICAgYy5zdHJva2UoKTtcbiAgfVxuXG4gIHJldHVybiBmdW5jdGlvbiByZW5kZXIoKSB7XG4gICAgYy5jbGVhclJlY3QoMCwgMCwgdywgaCk7XG5cbiAgICAvLyBkZXRlY3RlZCBvYmplY3RcbiAgICAoZnVuY3Rpb24oKSB7XG4gICAgICBpZiAoIWRldGVjdGVkKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgdmFyIHggPSB2aWRlb1RvT3ZlcmxheVgoZGV0ZWN0ZWQueCk7XG4gICAgICB2YXIgeSA9IHZpZGVvVG9PdmVybGF5WShkZXRlY3RlZC55KTtcblxuICAgICAgYy5iZWdpblBhdGgoKTtcbiAgICAgIGMubW92ZVRvKHgsIDApO1xuICAgICAgYy5saW5lVG8oeCwgb3ZlcmxheUNhbnZhcy5oZWlnaHQpO1xuICAgICAgYy5zdHJva2VTdHlsZSA9ICdyZ2JhKDI1NSwwLDAsMSknO1xuICAgICAgYy5zdHJva2UoKTtcblxuICAgICAgYy5iZWdpblBhdGgoKTtcbiAgICAgIGMubW92ZVRvKDAsIHkpO1xuICAgICAgYy5saW5lVG8ob3ZlcmxheUNhbnZhcy53aWR0aCwgeSk7XG4gICAgICBjLnN0cm9rZVN0eWxlID0gJ3JnYmEoMjU1LDAsMCwxKSc7XG4gICAgICBjLnN0cm9rZSgpO1xuICAgIH0pKCk7XG5cbiAgICAvLyB4UElEXG4gICAgKGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIHBpZCA9IHhQSUQucGlkKCk7XG4gICAgICB2YXIgZm9udFNpemUgPSAxNDtcbiAgICAgIHZhciBiYXJzID0gW1xuICAgICAgICB7bGFiZWw6ICdwJywgdmFsOiBwaWQucCwgY29sb3I6ICcyNTUsMCwwJ30sXG4gICAgICAgIHtsYWJlbDogJ2knLCB2YWw6IHBpZC5pLCBjb2xvcjogJzAsMjU1LDAnfSxcbiAgICAgICAge2xhYmVsOiAnZCcsIHZhbDogcGlkLmQsIGNvbG9yOiAnMCwwLDI1NSd9LFxuICAgICAgICB7bGFiZWw6ICdwaWQnLCB2YWw6IHBpZC5zdW0sIGNvbG9yOiAnMjU1LDI1NSwyNTUnfVxuICAgICAgXTtcbiAgICAgIHZhciBiaCA9IDEwO1xuICAgICAgdmFyIHlvID0gaCAvMiAtICgoYmggKyBmb250U2l6ZSArIHBhZGRpbmcpICogYmFycy5sZW5ndGgpIC8gMjtcblxuICAgICAgYmFycy5mb3JFYWNoKGZ1bmN0aW9uKGJhciwgaSkge1xuICAgICAgICB2YXIgeSA9IHlvICsgaSAqIChiaCArIGZvbnRTaXplICsgcGFkZGluZyk7XG4gICAgICAgIHZhciBidyA9IE1hdGguYWJzKGJhci52YWwgKiB3IC8gMik7XG4gICAgICAgIHZhciB4ID0gdyAvIDI7XG4gICAgICAgIGlmIChiYXIudmFsID4gMCkge1xuICAgICAgICAgIHggLT0gYnc7XG4gICAgICAgIH1cbiAgICAgICAgYy5maWxsU3R5bGUgPSAncmdiYSgnK2Jhci5jb2xvcisnLCcrb3BhY2l0eSoyKycpJztcbiAgICAgICAgYy5maWxsUmVjdCh4LCB5LCBidywgYmgpOyBcblxuICAgICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKDI1NSwyNTUsMjU1LCcrb3BhY2l0eSsnKSc7XG4gICAgICAgIGMuZm9udCA9IGZvbnRTaXplKydweCBBcmlhbCc7XG4gICAgICAgIGMuZmlsbFRleHQoYmFyLmxhYmVsLCB3LzIsIHktcGFkZGluZyk7XG4gICAgICB9KTtcblxuICAgIH0pKCk7XG5cbiAgICByZW5kZXJIaXN0b2dyYW1zKFtcbiAgICAgIHtsYWJlbDogJ3ZpZGVvJywgdmFsdWVzOiB2aWRlb0hpc3RvZ3JhbS52YWx1ZXMoKSwgbGltaXQ6IDEwMDAvMzB9LFxuICAgICAge2xhYmVsOiAnbmF2ZGF0YScsIHZhbHVlczogbmF2ZGF0YUhpc3RvZ3JhbS52YWx1ZXMoKSwgbGltaXQ6IDEwMDAvMTV9XG4gICAgXSk7XG5cbiAgICAvLyBiYXR0ZXJ5IG1ldGVyXG4gICAgKGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciB2YWx1ZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHZhbHVlID0gbGFzdE5hdmRhdGEuZGVtby5iYXR0ZXJ5UGVyY2VudGFnZTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB2YWx1ZSA9IDA7XG4gICAgICB9XG4gICAgICB2YXIgZnVsbFdpZHRoID0gNzA7XG4gICAgICB2YXIgZnVsbEhlaWdodCA9IDI0O1xuICAgICAgdmFyIGZvbnRTaXplID0gMTQ7XG4gICAgICB2YXIgd2lkdGggPSAoZnVsbFdpZHRoIC0gMikgKiB2YWx1ZSAvIDEwMDtcbiAgICAgIHZhciBsYWJlbCA9IHZhbHVlICsgJyAlJztcbiAgICAgIHZhciB4ID0gdy1mdWxsV2lkdGgtcGFkZGluZztcbiAgICAgIHZhciB5ID0gcGFkZGluZztcblxuICAgICAgYy5maWxsU3R5bGUgPSAncmdiYSgyNTUsMjU1LDI1NSwnK29wYWNpdHkrJyknO1xuICAgICAgYy5maWxsUmVjdCh4LCB5LCBmdWxsV2lkdGgsIGZ1bGxIZWlnaHQpOyBcbiAgICAgIGlmICh2YWx1ZSA8IDMwKSB7XG4gICAgICAgIGMuZmlsbFN0eWxlID0gJ3JnYmEoMjU1LDAsMCwnK29wYWNpdHkrJyknO1xuICAgICAgfSBlbHNlIGlmICh2YWx1ZSA8IDUwKSB7XG4gICAgICAgIGMuZmlsbFN0eWxlID0gJ3JnYmEoMjU1LDI1NSwwLCcrb3BhY2l0eSsnKSc7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKDAsMjU1LDAsJytvcGFjaXR5KycpJztcbiAgICAgIH1cbiAgICAgIGMuZmlsbFJlY3QoeCsxLCB5KzEsIHdpZHRoLCBmdWxsSGVpZ2h0LTIpOyBcblxuICAgICAgYy5maWxsU3R5bGUgPSAncmdiYSgwLDAsMCwnK29wYWNpdHkrJyknO1xuICAgICAgYy5mb250ID0gZm9udFNpemUrJ3B4IEFyaWFsJztcbiAgICAgIHZhciBsYWJlbFdpZHRoID0gYy5tZWFzdXJlVGV4dChsYWJlbCkud2lkdGg7XG4gICAgICBjLmZpbGxUZXh0KGxhYmVsLCB4KyhmdWxsV2lkdGgvMiktKGxhYmVsV2lkdGgvMiksIHkrKGZ1bGxIZWlnaHQvMikrKGZvbnRTaXplLzIpLTEpO1xuICAgIH0pKCk7XG5cbiAgICAvLyBjb2xvciBwaWNrZXJcbiAgICAoZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIHggPSBwYWRkaW5nO1xuICAgICAgdmFyIHkgPSBwYWRkaW5nO1xuICAgICAgdmFyIHNpemUgPSA1MDtcbiAgICAgIGMuZmlsbFN0eWxlID0gJ3JnYmEoMjU1LDI1NSwyNTUsJytvcGFjaXR5KycpJztcbiAgICAgIGMuZmlsbFJlY3QoeCwgeSwgc2l6ZSwgc2l6ZSk7IFxuXG4gICAgICBpZiAocGlja2VkQ29sb3IpIHtcbiAgICAgICAgYy5maWxsU3R5bGUgPSAncmdiYSgnK3BpY2tlZENvbG9yWzBdKycsJytwaWNrZWRDb2xvclsxXSsnLCcrcGlja2VkQ29sb3JbMl0rJywxKSc7XG4gICAgICAgIGMuZmlsbFJlY3QoeCsxLCB5KzEsIHNpemUtMiwgc2l6ZS0yKTsgXG4gICAgICB9XG4gICAgfSkoKTtcbiAgfTtcbn1cblxuLy8gS2VlcCB2aWRlbyBtYXhpbWl6ZWQgd2l0aGluIGJyb3dzZXIgd2luZG93IHdoaWxlIGtlZXBpbmcgdGhlIGFzcGVjdCByYXRpb1xuLy8gaW50YWN0Llxud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3Jlc2l6ZScsIG1heGltaXplVmlkZW8pO1xuZnVuY3Rpb24gbWF4aW1pemVWaWRlbygpIHtcbiAgdmFyIHdpZHRoLCBoZWlnaHQ7XG4gIHZhciB3aW5kb3dSYXRpbyA9IHdpbmRvdy5pbm5lcldpZHRoIC8gd2luZG93LmlubmVySGVpZ2h0O1xuICBpZiAod2luZG93UmF0aW8gPiBhc3BlY3RSYXRpbykge1xuICAgIGhlaWdodCA9IHdpbmRvdy5pbm5lckhlaWdodDtcbiAgICB3aWR0aCA9IGhlaWdodCphc3BlY3RSYXRpbztcbiAgfSBlbHNlIHtcbiAgICB3aWR0aCA9IHdpbmRvdy5pbm5lcldpZHRoO1xuICAgIGhlaWdodCA9IHdpZHRoL2FzcGVjdFJhdGlvO1xuICB9XG4gIFt2aWRlb0NhbnZhcywgb3ZlcmxheUNhbnZhc10uZm9yRWFjaChmdW5jdGlvbihjYW52YXMpIHtcbiAgICBjYW52YXMuc3R5bGUud2lkdGggPSB3aWR0aCsncHgnO1xuICAgIGNhbnZhcy5zdHlsZS5oZWlnaHQgPSBoZWlnaHQrJ3B4JztcbiAgICBjYW52YXMuc3R5bGUubWFyZ2luVG9wID0gKCh3aW5kb3cuaW5uZXJIZWlnaHQtaGVpZ2h0KS8yKSsncHgnO1xuICAgIGNhbnZhcy5zdHlsZS5tYXJnaW5MZWZ0ID0gKCh3aW5kb3cuaW5uZXJXaWR0aC13aWR0aCkvMikrJ3B4JztcbiAgfSk7XG59XG5cbm92ZXJsYXlDYW52YXMuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBmdW5jdGlvbihldmVudCkge1xuICB2YXIgeCA9IG92ZXJsYXlUb1ZpZGVvWChldmVudC5vZmZzZXRYKTtcbiAgdmFyIHkgPSBvdmVybGF5VG9WaWRlb1koZXZlbnQub2Zmc2V0WSk7XG4gIHBpY2tlZENvbG9yID0gcGlja2VkQ29sb3IgfHwgbmV3IFVpbnQ4QXJyYXkoNCk7XG4gIG5zLmdldEltYWdlRGF0YShwaWNrZWRDb2xvciwgeCwgdmlkZW9DYW52YXMuaGVpZ2h0LXksIDEsIDEpO1xufSk7XG5cbmZ1bmN0aW9uIG92ZXJsYXlUb1ZpZGVvWCh4KSB7XG4gIHJldHVybiBNYXRoLnJvdW5kKCh4IC8gcGFyc2VGbG9hdCh2aWRlb0NhbnZhcy5zdHlsZS53aWR0aCkpICogdmlkZW9DYW52YXMud2lkdGgpO1xufVxuXG5mdW5jdGlvbiBvdmVybGF5VG9WaWRlb1koeSkge1xuICByZXR1cm4gTWF0aC5yb3VuZCgoeSAvIHBhcnNlRmxvYXQodmlkZW9DYW52YXMuc3R5bGUuaGVpZ2h0KSkgKiB2aWRlb0NhbnZhcy5oZWlnaHQpO1xufVxuXG5mdW5jdGlvbiB2aWRlb1RvT3ZlcmxheVgoeCkge1xuICByZXR1cm4gTWF0aC5yb3VuZCh4IC8gdmlkZW9DYW52YXMud2lkdGggKiBvdmVybGF5Q2FudmFzLndpZHRoKTtcbn1cblxuZnVuY3Rpb24gdmlkZW9Ub092ZXJsYXlZKHkpIHtcbiAgcmV0dXJuIE1hdGgucm91bmQoeSAvIHZpZGVvQ2FudmFzLmhlaWdodCAqIG92ZXJsYXlDYW52YXMuaGVpZ2h0KTtcbn1cblxuZnVuY3Rpb24gc2V0U3RhdGUodmFsKSB7XG4gIGNvbnNvbGUubG9nKCduZXcgc3RhdGU6ICcrdmFsKTtcbiAgc3RhdGUgPSB2YWw7XG59XG5cbnZhciBmbGlnaHRCdXR0b24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmxpZ2h0Jyk7XG5mbGlnaHRCdXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMudGV4dENvbnRlbnQgPT09ICdTdGFydCcpIHtcbiAgICBzZXRTdGF0ZSgndGFrZW9mZicpO1xuICAgIGNsaWVudC5vbignYWx0aXR1ZGVDaGFuZ2UnLCBmdW5jdGlvbih2KXtcbiAgICAgIGlmKHYgPCAwLjMpIHtcbiAgICAgICAgdGhpcy5kb3duKDApO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGNsaWVudC50YWtlb2ZmKGZ1bmN0aW9uKCkge1xuICAgICAgc2V0U3RhdGUoJ2ZvbGxvdycpO1xuICAgICAgY2xpZW50LmRvd24oMS4wKTtcbiAgICAgIGNsaWVudC5mcm9udCgxLjApO1xuICAgIH0pO1xuICAgIHRoaXMudGV4dENvbnRlbnQgPSAnU3RvcCc7XG4gIH0gZWxzZSB7XG4gICAgc2V0U3RhdGUoJ2xhbmQnKTtcbiAgICBjbGllbnQubGFuZChmdW5jdGlvbigpIHtcbiAgICAgIHNldFN0YXRlKCdncm91bmQnKTtcbiAgICB9KTtcbiAgICB0aGlzLnRleHRDb250ZW50ID0gJ1N0YXJ0JztcbiAgfVxufSk7XG4iLCJcInVzZSBzdHJpY3RcIjtcblxubW9kdWxlLmV4cG9ydHMgPSBQSUQ7XG5mdW5jdGlvbiBQSUQob3B0aW9ucykge1xuICB0aGlzLl9wR2FpbiA9IG9wdGlvbnMucEdhaW4gfHwgMDtcbiAgdGhpcy5faUdhaW4gPSBvcHRpb25zLmlHYWluIHx8IDA7XG4gIHRoaXMuX2RHYWluID0gb3B0aW9ucy5kR2FpbiB8fCAwO1xuICB0aGlzLl9taW4gPSBvcHRpb25zLm1pbiB8fCAtMTtcbiAgdGhpcy5fbWF4ID0gb3B0aW9ucy5tYXggfHwgMTtcbiAgdGhpcy5femVybyA9IG9wdGlvbnMuemVybyB8fCAwO1xuXG4gIHRoaXMuX3AgPSAwO1xuICB0aGlzLl9pID0gMDtcbiAgdGhpcy5fZCA9IDA7XG4gIHRoaXMuX3N1bSA9IDA7XG5cbiAgdGhpcy5fdGFyZ2V0ID0gMDtcbiAgdGhpcy5fc3VtRXJyID0gMDtcbiAgdGhpcy5fbGFzdEVyciA9IDA7XG4gIHRoaXMuX2xhc3RUaW1lID0gbnVsbDtcblxuICB0aGlzLnRhcmdldCgwKTtcbn1cblxuUElELnByb3RvdHlwZS50YXJnZXQgPSBmdW5jdGlvbih2YWwpIHtcbiAgaWYgKHZhbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHRoaXMuX3RhcmdldDtcbiAgfVxuICB0aGlzLl9zdW1FcnIgPSAwO1xuICB0aGlzLl9sYXN0RXJyID0gMDtcbiAgdGhpcy5fbGFzdFRpbWUgPSBudWxsO1xuICB0aGlzLl9zdW0gPSB0aGlzLl9wID0gdGhpcy5faSA9IHRoaXMuX2QgPSB0aGlzLl96ZXJvO1xuICB0aGlzLl90YXJnZXQgPSB2YWw7XG4gIHJldHVybiB0aGlzLl90YXJnZXQ7XG59O1xuXG5QSUQucHJvdG90eXBlLnVwZGF0ZSA9IGZ1bmN0aW9uKHZhbCkge1xuICB2YXIgbm93ID0gRGF0ZS5ub3coKTtcbiAgdmFyIGR0ID0gMDtcbiAgaWYgKHRoaXMuX2xhc3RUaW1lICE9PSBudWxsKSB7XG4gICAgZHQgPSAobm93IC0gdGhpcy5fbGFzdFRpbWUpIC8gMTAwMDtcbiAgfVxuICB0aGlzLl9sYXN0VGltZSA9IG5vdztcblxuICB2YXIgZXJyID0gdGhpcy5fdGFyZ2V0IC0gdmFsO1xuICB2YXIgZEVyciA9IChlcnIgLSB0aGlzLl9sYXN0RXJyKSpkdDtcbiAgdGhpcy5fc3VtRXJyICs9IGVyciAqIGR0O1xuICB0aGlzLl9sYXN0RXJyID0gZXJyO1xuXG4gIHRoaXMuX3AgPSB0aGlzLl9wR2FpbiplcnI7XG4gIHRoaXMuX2kgPSB0aGlzLl9pR2Fpbip0aGlzLl9zdW1FcnI7XG4gIHRoaXMuX2QgPSB0aGlzLl9kR2FpbipkRXJyO1xuICB0aGlzLl9zdW0gPSB0aGlzLl9wK3RoaXMuX2krdGhpcy5fZDtcbiAgaWYgKHRoaXMuX3N1bSA8IHRoaXMuX21pbikge1xuICAgIHRoaXMuX3N1bSA9IHRoaXMuX21pbjtcbiAgfSBlbHNlIGlmICh0aGlzLl9zdW0gPiB0aGlzLl9tYXgpIHtcbiAgICB0aGlzLl9zdW0gPSB0aGlzLl9tYXg7XG4gIH1cbn07XG5cblBJRC5wcm90b3R5cGUucGlkID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB7cDogdGhpcy5fcCwgaTogdGhpcy5faSwgZDogdGhpcy5fZCwgc3VtOiB0aGlzLl9zdW19O1xufTtcbiIsIi8qIGdsb2JhbCB3aW5kb3csIFdlYlNvY2tldCAqLyBcblwidXNlIHN0cmljdFwiO1xubW9kdWxlLmV4cG9ydHMgPSBXc0NsaWVudDtcbmZ1bmN0aW9uIFdzQ2xpZW50KCkge1xuICB0aGlzLl9jb25uID0gbnVsbDtcbiAgdGhpcy5fY29ubmVjdGVkID0gZmFsc2U7XG4gIHRoaXMuX3F1ZXVlID0gW107XG4gIHRoaXMuX2xpc3RlbmVycyA9IHt9O1xuICB0aGlzLl90YWtlb2ZmQ2JzID0gW107XG4gIHRoaXMuX2xhbmRDYnMgPSBbXTtcbiAgdGhpcy5fY29ubmVjdCgpO1xufVxuXG5Xc0NsaWVudC5wcm90b3R5cGUuX2Nvbm5lY3QgPSBmdW5jdGlvbigpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBzZWxmLl9jb25uID0gbmV3IFdlYlNvY2tldCgnd3M6Ly8nK3dpbmRvdy5sb2NhdGlvbi5ob3N0KTtcbiAgc2VsZi5fY29ubi5vbm9wZW4gPSBmdW5jdGlvbigpIHtcbiAgICBzZWxmLl9jb25uZWN0ZWQgPSB0cnVlO1xuICAgIHNlbGYuX3F1ZXVlLmZvckVhY2goZnVuY3Rpb24obXNnKSB7XG4gICAgICBzZWxmLl9jb25uLnNlbmQobXNnKTtcbiAgICB9KTtcbiAgICBzZWxmLl9xdWV1ZSA9IFtdO1xuXG4gICAgc2VsZi5fY29ubi5vbm1lc3NhZ2UgPSBmdW5jdGlvbihtc2cpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIG1zZyA9IEpTT04ucGFyc2UobXNnLmRhdGEpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdmFyIGtpbmQgPSBtc2cuc2hpZnQoKTtcbiAgICAgIHN3aXRjaCAoa2luZCkge1xuICAgICAgICBjYXNlICd0YWtlb2ZmJzpcbiAgICAgICAgICBzZWxmLl90YWtlb2ZmQ2JzLmZvckVhY2goZnVuY3Rpb24oY2IpIHtcbiAgICAgICAgICAgIGNiKCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgc2VsZi5fdGFrZW9mZkNicyA9IFtdO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdsYW5kJzpcbiAgICAgICAgICBzZWxmLl9sYW5kQ2JzLmZvckVhY2goZnVuY3Rpb24oY2IpIHtcbiAgICAgICAgICAgIGNiKCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgc2VsZi5fbGFuZENicyA9IFtdO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdvbic6XG4gICAgICAgICAgdmFyIGV2ZW50ID0gbXNnLnNoaWZ0KCk7XG4gICAgICAgICAgc2VsZi5fbGlzdGVuZXJzW2V2ZW50XS5mb3JFYWNoKGZ1bmN0aW9uKGNiKSB7XG4gICAgICAgICAgICBjYi5hcHBseShzZWxmLCBtc2cpO1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ3Vua25vd24gbWVzc2FnZTogJytraW5kKTtcbiAgICAgIH1cbiAgICB9O1xuICB9O1xuXG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUuX3NlbmQgPSBmdW5jdGlvbihtc2cpIHtcbiAgbXNnID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgaWYgKCF0aGlzLl9jb25uZWN0ZWQpIHtcbiAgICB0aGlzLl9xdWV1ZS5wdXNoKG1zZyk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRoaXMuX2Nvbm4uc2VuZChtc2cpO1xufTtcblxuV3NDbGllbnQucHJvdG90eXBlLm9uID0gZnVuY3Rpb24oZXZlbnQsIGNiKSB7XG4gIHZhciBjYnMgPSB0aGlzLl9saXN0ZW5lcnNbZXZlbnRdID0gdGhpcy5fbGlzdGVuZXJzW2V2ZW50XSB8fCBbXTtcbiAgY2JzLnB1c2goY2IpO1xuICBpZiAoY2JzLmxlbmd0aCA9PT0gMSkge1xuICAgIHRoaXMuX3NlbmQoWydvbicsIGV2ZW50XSk7XG4gIH1cbn07XG5cbldzQ2xpZW50LnByb3RvdHlwZS50YWtlb2ZmID0gZnVuY3Rpb24oY2IpIHtcbiAgdGhpcy5fc2VuZChbJ3Rha2VvZmYnXSk7XG4gIGlmIChjYikge1xuICAgIHRoaXMuX3Rha2VvZmZDYnMucHVzaChjYik7XG4gIH1cbn07XG5cbldzQ2xpZW50LnByb3RvdHlwZS5sYW5kID0gZnVuY3Rpb24oY2IpIHtcbiAgdGhpcy5fc2VuZChbJ2xhbmQnXSk7XG4gIGlmIChjYikge1xuICAgIHRoaXMuX2xhbmRDYnMucHVzaChjYik7XG4gIH1cbn07XG5cbldzQ2xpZW50LnByb3RvdHlwZS5yaWdodCA9IGZ1bmN0aW9uKHZhbCkge1xuICB0aGlzLl9zZW5kKFsncmlnaHQnLCB2YWxdKTtcbn07XG5cblxuV3NDbGllbnQucHJvdG90eXBlLmRvd24gPSBmdW5jdGlvbih2YWwpIHtcbiAgdGhpcy5fc2VuZChbJ2Rvd24nLCB2YWxdKTtcbn07XG5cbldzQ2xpZW50LnByb3RvdHlwZS51cCA9IGZ1bmN0aW9uKHZhbCkge1xuICB0aGlzLl9zZW5kKFsndXAnLCB2YWxdKTtcbn07XG5cbldzQ2xpZW50LnByb3RvdHlwZS5mcm9udCA9IGZ1bmN0aW9uKHZhbCkge1xuICB0aGlzLl9zZW5kKFsnZnJvbnQnLCB2YWxdKTtcbn07XG5cblxuV3NDbGllbnQucHJvdG90eXBlLnN0b3AgPSBmdW5jdGlvbigpIHtcbiAgdGhpcy5fc2VuZChbJ3N0b3AnXSk7XG59O1xuIl19
