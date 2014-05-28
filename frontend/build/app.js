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
var detect = detector({maxDiff: 0.1});
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
    for (var x = 0; x < w; x++) {
      for (var y = 0; y < h; y++) {
        var o = x*4+(h-y)*w*4;
        var match = true;
        for (var i = 0; i < pickedColor.length; i++) {
          var diffPercent = Math.abs(b[o+i]-pickedColor[i]) / 255;
          if (diffPercent > maxDiff) {
            match = false;
            break;
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
      client.right(-xPID.pid().sum);
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
        {label: 'pid', val: pid.sum, color: '255,255,255'},
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
      {label: 'navdata', values: navdataHistogram.values(), limit: 1000/15},
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
    client.takeoff(function() {
      setState('follow');
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

WsClient.prototype.stop = function() {
  this._send(['stop']);
};

},{}]},{},[2])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlcyI6WyIvVXNlcnMvZmVsaXgvY29kZS9hcmRyb25lLXNvY2Nlci9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvYnJvd3Nlci1wYWNrL19wcmVsdWRlLmpzIiwiL1VzZXJzL2ZlbGl4L2NvZGUvYXJkcm9uZS1zb2NjZXIvZnJvbnRlbmQvanMvaGlzdG9ncmFtLmpzIiwiL1VzZXJzL2ZlbGl4L2NvZGUvYXJkcm9uZS1zb2NjZXIvZnJvbnRlbmQvanMvbWFpbi5qcyIsIi9Vc2Vycy9mZWxpeC9jb2RlL2FyZHJvbmUtc29jY2VyL2Zyb250ZW5kL2pzL3BpZC5qcyIsIi9Vc2Vycy9mZWxpeC9jb2RlL2FyZHJvbmUtc29jY2VyL2Zyb250ZW5kL2pzL3dzX2NsaWVudC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1VEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt0aHJvdyBuZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpfXZhciBmPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChmLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGYsZi5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCJcInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID0gSGlzdG9ncmFtO1xuZnVuY3Rpb24gSGlzdG9ncmFtKGhpc3RvZ3JhbVNpemUpIHtcbiAgdGhpcy5fcHJldiA9IERhdGUubm93KCk7XG4gIHRoaXMuX2hpc3RvZ3JhbSA9IFtdO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGhpc3RvZ3JhbVNpemU7IGkrKykge1xuICAgIHRoaXMuX2hpc3RvZ3JhbS5wdXNoKDApO1xuICB9XG59XG5cbkhpc3RvZ3JhbS5wcm90b3R5cGUudGljayA9IGZ1bmN0aW9uKCkge1xuICB2YXIgbGF0ZW5jeSA9IERhdGUubm93KCkgLSB0aGlzLl9wcmV2O1xuICB0aGlzLl9oaXN0b2dyYW0ucHVzaChsYXRlbmN5KTtcbiAgdGhpcy5faGlzdG9ncmFtLnNoaWZ0KCk7XG4gIHRoaXMuX3ByZXYgPSBEYXRlLm5vdygpO1xufTtcblxuSGlzdG9ncmFtLnByb3RvdHlwZS52YWx1ZXMgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuX2hpc3RvZ3JhbTtcbn07XG4iLCIvKiBnbG9iYWwgZG9jdW1lbnQsIE5vZGVjb3B0ZXJTdHJlYW0sIHdpbmRvdywgcmVxdWVzdEFuaW1hdGlvbkZyYW1lLCBVaW50OEFycmF5ICovIFxuXCJ1c2Ugc3RyaWN0XCI7XG52YXIgSGlzdG9ncmFtID0gcmVxdWlyZSgnLi9oaXN0b2dyYW0nKTtcbnZhciBXc0NsaWVudCA9IHJlcXVpcmUoJy4vd3NfY2xpZW50Jyk7XG52YXIgUElEID0gcmVxdWlyZSgnLi9waWQnKTtcblxudmFyIHZpZGVvRGl2ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ZpZGVvJyk7XG52YXIgbnMgPSBuZXcgTm9kZWNvcHRlclN0cmVhbSh2aWRlb0Rpdiwge3BvcnQ6IDMwMDF9KTtcbnZhciB2aWRlb0NhbnZhcyA9IHZpZGVvRGl2LnF1ZXJ5U2VsZWN0b3IoJ2NhbnZhcycpO1xudmFyIGFzcGVjdFJhdGlvID0gdmlkZW9DYW52YXMud2lkdGggLyB2aWRlb0NhbnZhcy5oZWlnaHQ7XG52YXIgb3ZlcmxheUNhbnZhcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdvdmVybGF5Jyk7XG52YXIgb3ZlcmxheUNvbnRleHQgPSBvdmVybGF5Q2FudmFzLmdldENvbnRleHQoJzJkJyk7XG52YXIgZnJhbWVCdWZmZXIgPSBuZXcgVWludDhBcnJheSh2aWRlb0NhbnZhcy53aWR0aCAqIHZpZGVvQ2FudmFzLmhlaWdodCAqIDQpO1xudmFyIHZpZGVvSGlzdG9ncmFtID0gbmV3IEhpc3RvZ3JhbSgyMDApO1xudmFyIG5hdmRhdGFIaXN0b2dyYW0gPSBuZXcgSGlzdG9ncmFtKDIwMCk7XG52YXIgcmVuZGVyID0gcmVuZGVyZXIoKTtcbnZhciBkZXRlY3QgPSBkZXRlY3Rvcih7bWF4RGlmZjogMC4xfSk7XG52YXIgbGFzdE5hdmRhdGE7XG52YXIgcGlja2VkQ29sb3I7XG52YXIgZGV0ZWN0ZWQ7XG52YXIgeFBJRCA9IG5ldyBQSUQoe3BHYWluOiAwLjEsIGlHYWluOiAwLCBkR2FpbjogMH0pO1xudmFyIGNsaWVudCA9IG5ldyBXc0NsaWVudCgpO1xudmFyIHN0YXRlO1xuc2V0U3RhdGUoJ2dyb3VuZCcpO1xuXG4vLyBtYWluIGdldHMgdGhpcyBwYXJ0eSBzdGFydGVkLlxuKGZ1bmN0aW9uIG1haW4oKSB7XG4gIG1heGltaXplVmlkZW8oKTtcbiAgcmVuZGVyTG9vcCgpO1xuICBucy5vbk5leHRGcmFtZShmcmFtZUxvb3ApO1xuICBjbGllbnQub24oJ25hdmRhdGEnLCBmdW5jdGlvbihkYXRhKSB7XG4gICAgbGFzdE5hdmRhdGEgPSBkYXRhO1xuICAgIG5hdmRhdGFIaXN0b2dyYW0udGljaygpO1xuICB9KTtcbn0pKCk7XG5cbi8vIHJlbmRlckxvb3AgZHJpdmVzIHRoZSByZW5kZXJlci5cbmZ1bmN0aW9uIHJlbmRlckxvb3AoKSB7XG4gIHJlbmRlcigpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUocmVuZGVyTG9vcCk7XG59XG5cbi8vIGZyYW1lTG9vcCBhbmFseXplcyBpbmNvbWluZyB2aWRlbyBmcmFtZXMuXG5mdW5jdGlvbiBmcmFtZUxvb3AoKSB7XG4gIHZpZGVvSGlzdG9ncmFtLnRpY2soKTtcblxuICBpZiAocGlja2VkQ29sb3IpIHtcbiAgICBkZXRlY3QoKTtcbiAgfVxuXG4gIG5zLm9uTmV4dEZyYW1lKGZyYW1lTG9vcCk7XG59XG5cbi8vIGRldGVjdG9yIHJldHVybnMgYSBmdW5jdGlvbiB0aGF0IHRyaWVzIHRvIGZpbmQgYSBjb2xvcmVkIG9iamVjdCBpbiB0aGUgaW1hZ2UuXG5mdW5jdGlvbiBkZXRlY3RvcihvcHRpb25zKSB7XG4gIHZhciBtYXhEaWZmID0gb3B0aW9ucy5tYXhEaWZmO1xuICB2YXIgdyA9IHZpZGVvQ2FudmFzLndpZHRoO1xuICB2YXIgaCA9IHZpZGVvQ2FudmFzLmhlaWdodDtcbiAgdmFyIGIgPSBmcmFtZUJ1ZmZlcjtcblxuICByZXR1cm4gZnVuY3Rpb24gZGV0ZWN0KCkge1xuICAgIG5zLmdldEltYWdlRGF0YShiKTtcblxuICAgIHZhciBjb3VudCA9IDA7XG4gICAgdmFyIHhTdW0gPSAwO1xuICAgIHZhciB5U3VtID0gMDtcbiAgICBmb3IgKHZhciB4ID0gMDsgeCA8IHc7IHgrKykge1xuICAgICAgZm9yICh2YXIgeSA9IDA7IHkgPCBoOyB5KyspIHtcbiAgICAgICAgdmFyIG8gPSB4KjQrKGgteSkqdyo0O1xuICAgICAgICB2YXIgbWF0Y2ggPSB0cnVlO1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHBpY2tlZENvbG9yLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgdmFyIGRpZmZQZXJjZW50ID0gTWF0aC5hYnMoYltvK2ldLXBpY2tlZENvbG9yW2ldKSAvIDI1NTtcbiAgICAgICAgICBpZiAoZGlmZlBlcmNlbnQgPiBtYXhEaWZmKSB7XG4gICAgICAgICAgICBtYXRjaCA9IGZhbHNlO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgICAgY291bnQrKztcbiAgICAgICAgICB4U3VtICs9IHg7XG4gICAgICAgICAgeVN1bSArPSB5O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGRldGVjdGVkID0ge3g6IHhTdW0gLyBjb3VudCwgeTogeVN1bSAvY291bnR9O1xuICAgIHZhciB4VmFsID0gKGRldGVjdGVkLnggLSB3IC8gMikvKHcgLyAyKTtcbiAgICB4UElELnVwZGF0ZSh4VmFsKTtcblxuICAgIGlmIChzdGF0ZSA9PT0gJ2ZvbGxvdycpIHtcbiAgICAgIGNsaWVudC5yaWdodCgteFBJRC5waWQoKS5zdW0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjbGllbnQuc3RvcCgpO1xuICAgIH1cbiAgfTtcbn1cblxuLy8gcmVuZGVyZXIgcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbmRlciB0aGUgb3ZlcmxheSBjYW52YXMuIFRoZSBjb29yZGluYXRlXG4vLyBzeXN0ZW0gaXMgc2V0IHVwIHNvIHRoYXQgKDAsMCkgaXMgdGhlIHRvcCBsZWZ0IG9mIHRoZSBjYW52YXMuXG5mdW5jdGlvbiByZW5kZXJlcigpIHtcbiAgdmFyIHBhZGRpbmcgPSAxMDtcbiAgdmFyIHNwYWNpbmcgPSAyMDtcbiAgdmFyIGMgPSBvdmVybGF5Q29udGV4dDtcbiAgdmFyIHcgPSBvdmVybGF5Q2FudmFzLndpZHRoO1xuICB2YXIgaCA9IG92ZXJsYXlDYW52YXMuaGVpZ2h0O1xuICB2YXIgb3BhY2l0eSA9IDAuMztcblxuICBmdW5jdGlvbiByZW5kZXJIaXN0b2dyYW1zKGhpc3RvZ3JhbXMpIHtcbiAgICB2YXIgb2Zmc2V0ID0gMDtcbiAgICBoaXN0b2dyYW1zLmZvckVhY2goZnVuY3Rpb24oaCkge1xuICAgICAgcmVuZGVySGlzdG9ncmFtKGgubGFiZWwsIGgudmFsdWVzLCBoLmxpbWl0LCBvZmZzZXQpO1xuICAgICAgb2Zmc2V0ICs9IGgudmFsdWVzLmxlbmd0aCtzcGFjaW5nO1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVuZGVySGlzdG9ncmFtKGxhYmVsLCB2YWx1ZXMsIGxpbWl0LCBvZmZzZXQpIHtcbiAgICAvLyBvZmZzZXQgaXMgbnVtYmVyIG9mIHBpeGVscyBmcm9tIHJpZ2h0IHRvIG9mZnNldCB0aGUgaGlzdG9ncmFtLlxuICAgIG9mZnNldCA9IG9mZnNldCB8fCAwO1xuICAgIHZhciBmb250U2l6ZSA9IDIwO1xuXG4gICAgYy5maWxsU3R5bGUgPSAncmdiYSgyNTUsMjU1LDI1NSwnK29wYWNpdHkrJyknO1xuICAgIGMuZm9udCA9IGZvbnRTaXplKydweCBBcmlhbCc7XG4gICAgdmFyIGxhYmVsV2lkdGggPSBjLm1lYXN1cmVUZXh0KGxhYmVsKS53aWR0aDtcbiAgICBjLmZpbGxUZXh0KGxhYmVsLCB3LShsYWJlbFdpZHRoLzIpLSh2YWx1ZXMubGVuZ3RoLzIpLXBhZGRpbmctb2Zmc2V0LCBoLXBhZGRpbmcpO1xuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YWx1ZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIHZhciB4ID0gdy1pLXBhZGRpbmctb2Zmc2V0O1xuICAgICAgYy5iZWdpblBhdGgoKTtcbiAgICAgIGMubW92ZVRvKHgsIGgtZm9udFNpemUtcGFkZGluZyk7XG4gICAgICBjLmxpbmVUbyh4LCBoLXZhbHVlc1tpXS1mb250U2l6ZS1wYWRkaW5nKTtcbiAgICAgIGMuc3Ryb2tlU3R5bGUgPSAncmdiYSgyNTUsMjU1LDI1NSwnK29wYWNpdHkrJyknO1xuICAgICAgYy5zdHJva2UoKTtcbiAgICB9XG5cbiAgICB2YXIgbGltaXRZID0gaC1mb250U2l6ZS1wYWRkaW5nLWxpbWl0O1xuICAgIGMuYmVnaW5QYXRoKCk7XG4gICAgYy5tb3ZlVG8ody1wYWRkaW5nLXZhbHVlcy5sZW5ndGgtb2Zmc2V0LCBsaW1pdFkpO1xuICAgIGMubGluZVRvKHctcGFkZGluZy1vZmZzZXQsIGxpbWl0WSk7XG4gICAgYy5zdHJva2VTdHlsZSA9ICdyZ2JhKDI1NSwwLDAsJytvcGFjaXR5KycpJztcbiAgICBjLnN0cm9rZSgpO1xuICB9XG5cbiAgcmV0dXJuIGZ1bmN0aW9uIHJlbmRlcigpIHtcbiAgICBjLmNsZWFyUmVjdCgwLCAwLCB3LCBoKTtcblxuICAgIC8vIGRldGVjdGVkIG9iamVjdFxuICAgIChmdW5jdGlvbigpIHtcbiAgICAgIGlmICghZGV0ZWN0ZWQpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICB2YXIgeCA9IHZpZGVvVG9PdmVybGF5WChkZXRlY3RlZC54KTtcbiAgICAgIHZhciB5ID0gdmlkZW9Ub092ZXJsYXlZKGRldGVjdGVkLnkpO1xuXG4gICAgICBjLmJlZ2luUGF0aCgpO1xuICAgICAgYy5tb3ZlVG8oeCwgMCk7XG4gICAgICBjLmxpbmVUbyh4LCBvdmVybGF5Q2FudmFzLmhlaWdodCk7XG4gICAgICBjLnN0cm9rZVN0eWxlID0gJ3JnYmEoMjU1LDAsMCwxKSc7XG4gICAgICBjLnN0cm9rZSgpO1xuXG4gICAgICBjLmJlZ2luUGF0aCgpO1xuICAgICAgYy5tb3ZlVG8oMCwgeSk7XG4gICAgICBjLmxpbmVUbyhvdmVybGF5Q2FudmFzLndpZHRoLCB5KTtcbiAgICAgIGMuc3Ryb2tlU3R5bGUgPSAncmdiYSgyNTUsMCwwLDEpJztcbiAgICAgIGMuc3Ryb2tlKCk7XG4gICAgfSkoKTtcblxuICAgIC8vIHhQSURcbiAgICAoZnVuY3Rpb24oKSB7XG4gICAgICB2YXIgcGlkID0geFBJRC5waWQoKTtcbiAgICAgIHZhciBmb250U2l6ZSA9IDE0O1xuICAgICAgdmFyIGJhcnMgPSBbXG4gICAgICAgIHtsYWJlbDogJ3AnLCB2YWw6IHBpZC5wLCBjb2xvcjogJzI1NSwwLDAnfSxcbiAgICAgICAge2xhYmVsOiAnaScsIHZhbDogcGlkLmksIGNvbG9yOiAnMCwyNTUsMCd9LFxuICAgICAgICB7bGFiZWw6ICdkJywgdmFsOiBwaWQuZCwgY29sb3I6ICcwLDAsMjU1J30sXG4gICAgICAgIHtsYWJlbDogJ3BpZCcsIHZhbDogcGlkLnN1bSwgY29sb3I6ICcyNTUsMjU1LDI1NSd9LFxuICAgICAgXTtcbiAgICAgIHZhciBiaCA9IDEwO1xuICAgICAgdmFyIHlvID0gaCAvMiAtICgoYmggKyBmb250U2l6ZSArIHBhZGRpbmcpICogYmFycy5sZW5ndGgpIC8gMjtcblxuICAgICAgYmFycy5mb3JFYWNoKGZ1bmN0aW9uKGJhciwgaSkge1xuICAgICAgICB2YXIgeSA9IHlvICsgaSAqIChiaCArIGZvbnRTaXplICsgcGFkZGluZyk7XG4gICAgICAgIHZhciBidyA9IE1hdGguYWJzKGJhci52YWwgKiB3IC8gMik7XG4gICAgICAgIHZhciB4ID0gdyAvIDI7XG4gICAgICAgIGlmIChiYXIudmFsID4gMCkge1xuICAgICAgICAgIHggLT0gYnc7XG4gICAgICAgIH1cbiAgICAgICAgYy5maWxsU3R5bGUgPSAncmdiYSgnK2Jhci5jb2xvcisnLCcrb3BhY2l0eSoyKycpJztcbiAgICAgICAgYy5maWxsUmVjdCh4LCB5LCBidywgYmgpOyBcblxuICAgICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKDI1NSwyNTUsMjU1LCcrb3BhY2l0eSsnKSc7XG4gICAgICAgIGMuZm9udCA9IGZvbnRTaXplKydweCBBcmlhbCc7XG4gICAgICAgIGMuZmlsbFRleHQoYmFyLmxhYmVsLCB3LzIsIHktcGFkZGluZyk7XG4gICAgICB9KTtcblxuICAgIH0pKCk7XG5cbiAgICByZW5kZXJIaXN0b2dyYW1zKFtcbiAgICAgIHtsYWJlbDogJ3ZpZGVvJywgdmFsdWVzOiB2aWRlb0hpc3RvZ3JhbS52YWx1ZXMoKSwgbGltaXQ6IDEwMDAvMzB9LFxuICAgICAge2xhYmVsOiAnbmF2ZGF0YScsIHZhbHVlczogbmF2ZGF0YUhpc3RvZ3JhbS52YWx1ZXMoKSwgbGltaXQ6IDEwMDAvMTV9LFxuICAgIF0pO1xuXG4gICAgLy8gYmF0dGVyeSBtZXRlclxuICAgIChmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgdmFsdWU7XG4gICAgICB0cnkge1xuICAgICAgICB2YWx1ZSA9IGxhc3ROYXZkYXRhLmRlbW8uYmF0dGVyeVBlcmNlbnRhZ2U7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgdmFsdWUgPSAwO1xuICAgICAgfVxuICAgICAgdmFyIGZ1bGxXaWR0aCA9IDcwO1xuICAgICAgdmFyIGZ1bGxIZWlnaHQgPSAyNDtcbiAgICAgIHZhciBmb250U2l6ZSA9IDE0O1xuICAgICAgdmFyIHdpZHRoID0gKGZ1bGxXaWR0aCAtIDIpICogdmFsdWUgLyAxMDA7XG4gICAgICB2YXIgbGFiZWwgPSB2YWx1ZSArICcgJSc7XG4gICAgICB2YXIgeCA9IHctZnVsbFdpZHRoLXBhZGRpbmc7XG4gICAgICB2YXIgeSA9IHBhZGRpbmc7XG5cbiAgICAgIGMuZmlsbFN0eWxlID0gJ3JnYmEoMjU1LDI1NSwyNTUsJytvcGFjaXR5KycpJztcbiAgICAgIGMuZmlsbFJlY3QoeCwgeSwgZnVsbFdpZHRoLCBmdWxsSGVpZ2h0KTsgXG4gICAgICBpZiAodmFsdWUgPCAzMCkge1xuICAgICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKDI1NSwwLDAsJytvcGFjaXR5KycpJztcbiAgICAgIH0gZWxzZSBpZiAodmFsdWUgPCA1MCkge1xuICAgICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKDI1NSwyNTUsMCwnK29wYWNpdHkrJyknO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYy5maWxsU3R5bGUgPSAncmdiYSgwLDI1NSwwLCcrb3BhY2l0eSsnKSc7XG4gICAgICB9XG4gICAgICBjLmZpbGxSZWN0KHgrMSwgeSsxLCB3aWR0aCwgZnVsbEhlaWdodC0yKTsgXG5cbiAgICAgIGMuZmlsbFN0eWxlID0gJ3JnYmEoMCwwLDAsJytvcGFjaXR5KycpJztcbiAgICAgIGMuZm9udCA9IGZvbnRTaXplKydweCBBcmlhbCc7XG4gICAgICB2YXIgbGFiZWxXaWR0aCA9IGMubWVhc3VyZVRleHQobGFiZWwpLndpZHRoO1xuICAgICAgYy5maWxsVGV4dChsYWJlbCwgeCsoZnVsbFdpZHRoLzIpLShsYWJlbFdpZHRoLzIpLCB5KyhmdWxsSGVpZ2h0LzIpKyhmb250U2l6ZS8yKS0xKTtcbiAgICB9KSgpO1xuXG4gICAgLy8gY29sb3IgcGlja2VyXG4gICAgKGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciB4ID0gcGFkZGluZztcbiAgICAgIHZhciB5ID0gcGFkZGluZztcbiAgICAgIHZhciBzaXplID0gNTA7XG4gICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKDI1NSwyNTUsMjU1LCcrb3BhY2l0eSsnKSc7XG4gICAgICBjLmZpbGxSZWN0KHgsIHksIHNpemUsIHNpemUpOyBcblxuICAgICAgaWYgKHBpY2tlZENvbG9yKSB7XG4gICAgICAgIGMuZmlsbFN0eWxlID0gJ3JnYmEoJytwaWNrZWRDb2xvclswXSsnLCcrcGlja2VkQ29sb3JbMV0rJywnK3BpY2tlZENvbG9yWzJdKycsMSknO1xuICAgICAgICBjLmZpbGxSZWN0KHgrMSwgeSsxLCBzaXplLTIsIHNpemUtMik7IFxuICAgICAgfVxuICAgIH0pKCk7XG4gIH07XG59XG5cbi8vIEtlZXAgdmlkZW8gbWF4aW1pemVkIHdpdGhpbiBicm93c2VyIHdpbmRvdyB3aGlsZSBrZWVwaW5nIHRoZSBhc3BlY3QgcmF0aW9cbi8vIGludGFjdC5cbndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdyZXNpemUnLCBtYXhpbWl6ZVZpZGVvKTtcbmZ1bmN0aW9uIG1heGltaXplVmlkZW8oKSB7XG4gIHZhciB3aWR0aCwgaGVpZ2h0O1xuICB2YXIgd2luZG93UmF0aW8gPSB3aW5kb3cuaW5uZXJXaWR0aCAvIHdpbmRvdy5pbm5lckhlaWdodDtcbiAgaWYgKHdpbmRvd1JhdGlvID4gYXNwZWN0UmF0aW8pIHtcbiAgICBoZWlnaHQgPSB3aW5kb3cuaW5uZXJIZWlnaHQ7XG4gICAgd2lkdGggPSBoZWlnaHQqYXNwZWN0UmF0aW87XG4gIH0gZWxzZSB7XG4gICAgd2lkdGggPSB3aW5kb3cuaW5uZXJXaWR0aDtcbiAgICBoZWlnaHQgPSB3aWR0aC9hc3BlY3RSYXRpbztcbiAgfVxuICBbdmlkZW9DYW52YXMsIG92ZXJsYXlDYW52YXNdLmZvckVhY2goZnVuY3Rpb24oY2FudmFzKSB7XG4gICAgY2FudmFzLnN0eWxlLndpZHRoID0gd2lkdGgrJ3B4JztcbiAgICBjYW52YXMuc3R5bGUuaGVpZ2h0ID0gaGVpZ2h0KydweCc7XG4gICAgY2FudmFzLnN0eWxlLm1hcmdpblRvcCA9ICgod2luZG93LmlubmVySGVpZ2h0LWhlaWdodCkvMikrJ3B4JztcbiAgICBjYW52YXMuc3R5bGUubWFyZ2luTGVmdCA9ICgod2luZG93LmlubmVyV2lkdGgtd2lkdGgpLzIpKydweCc7XG4gIH0pO1xufVxuXG5vdmVybGF5Q2FudmFzLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZnVuY3Rpb24oZXZlbnQpIHtcbiAgdmFyIHggPSBvdmVybGF5VG9WaWRlb1goZXZlbnQub2Zmc2V0WCk7XG4gIHZhciB5ID0gb3ZlcmxheVRvVmlkZW9ZKGV2ZW50Lm9mZnNldFkpO1xuICBwaWNrZWRDb2xvciA9IHBpY2tlZENvbG9yIHx8IG5ldyBVaW50OEFycmF5KDQpO1xuICBucy5nZXRJbWFnZURhdGEocGlja2VkQ29sb3IsIHgsIHZpZGVvQ2FudmFzLmhlaWdodC15LCAxLCAxKTtcbn0pO1xuXG5mdW5jdGlvbiBvdmVybGF5VG9WaWRlb1goeCkge1xuICByZXR1cm4gTWF0aC5yb3VuZCgoeCAvIHBhcnNlRmxvYXQodmlkZW9DYW52YXMuc3R5bGUud2lkdGgpKSAqIHZpZGVvQ2FudmFzLndpZHRoKTtcbn1cblxuZnVuY3Rpb24gb3ZlcmxheVRvVmlkZW9ZKHkpIHtcbiAgcmV0dXJuIE1hdGgucm91bmQoKHkgLyBwYXJzZUZsb2F0KHZpZGVvQ2FudmFzLnN0eWxlLmhlaWdodCkpICogdmlkZW9DYW52YXMuaGVpZ2h0KTtcbn1cblxuZnVuY3Rpb24gdmlkZW9Ub092ZXJsYXlYKHgpIHtcbiAgcmV0dXJuIE1hdGgucm91bmQoeCAvIHZpZGVvQ2FudmFzLndpZHRoICogb3ZlcmxheUNhbnZhcy53aWR0aCk7XG59XG5cbmZ1bmN0aW9uIHZpZGVvVG9PdmVybGF5WSh5KSB7XG4gIHJldHVybiBNYXRoLnJvdW5kKHkgLyB2aWRlb0NhbnZhcy5oZWlnaHQgKiBvdmVybGF5Q2FudmFzLmhlaWdodCk7XG59XG5cbmZ1bmN0aW9uIHNldFN0YXRlKHZhbCkge1xuICBjb25zb2xlLmxvZygnbmV3IHN0YXRlOiAnK3ZhbCk7XG4gIHN0YXRlID0gdmFsO1xufVxuXG52YXIgZmxpZ2h0QnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZsaWdodCcpO1xuZmxpZ2h0QnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLnRleHRDb250ZW50ID09PSAnU3RhcnQnKSB7XG4gICAgc2V0U3RhdGUoJ3Rha2VvZmYnKTtcbiAgICBjbGllbnQudGFrZW9mZihmdW5jdGlvbigpIHtcbiAgICAgIHNldFN0YXRlKCdmb2xsb3cnKTtcbiAgICB9KTtcbiAgICB0aGlzLnRleHRDb250ZW50ID0gJ1N0b3AnO1xuICB9IGVsc2Uge1xuICAgIHNldFN0YXRlKCdsYW5kJyk7XG4gICAgY2xpZW50LmxhbmQoZnVuY3Rpb24oKSB7XG4gICAgICBzZXRTdGF0ZSgnZ3JvdW5kJyk7XG4gICAgfSk7XG4gICAgdGhpcy50ZXh0Q29udGVudCA9ICdTdGFydCc7XG4gIH1cbn0pO1xuIiwiXCJ1c2Ugc3RyaWN0XCI7XG5cbm1vZHVsZS5leHBvcnRzID0gUElEO1xuZnVuY3Rpb24gUElEKG9wdGlvbnMpIHtcbiAgdGhpcy5fcEdhaW4gPSBvcHRpb25zLnBHYWluIHx8IDA7XG4gIHRoaXMuX2lHYWluID0gb3B0aW9ucy5pR2FpbiB8fCAwO1xuICB0aGlzLl9kR2FpbiA9IG9wdGlvbnMuZEdhaW4gfHwgMDtcbiAgdGhpcy5fbWluID0gb3B0aW9ucy5taW4gfHwgLTE7XG4gIHRoaXMuX21heCA9IG9wdGlvbnMubWF4IHx8IDE7XG4gIHRoaXMuX3plcm8gPSBvcHRpb25zLnplcm8gfHwgMDtcblxuICB0aGlzLl9wID0gMDtcbiAgdGhpcy5faSA9IDA7XG4gIHRoaXMuX2QgPSAwO1xuICB0aGlzLl9zdW0gPSAwO1xuXG4gIHRoaXMuX3RhcmdldCA9IDA7XG4gIHRoaXMuX3N1bUVyciA9IDA7XG4gIHRoaXMuX2xhc3RFcnIgPSAwO1xuICB0aGlzLl9sYXN0VGltZSA9IG51bGw7XG5cbiAgdGhpcy50YXJnZXQoMCk7XG59XG5cblBJRC5wcm90b3R5cGUudGFyZ2V0ID0gZnVuY3Rpb24odmFsKSB7XG4gIGlmICh2YWwgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB0aGlzLl90YXJnZXQ7XG4gIH1cbiAgdGhpcy5fc3VtRXJyID0gMDtcbiAgdGhpcy5fbGFzdEVyciA9IDA7XG4gIHRoaXMuX2xhc3RUaW1lID0gbnVsbDtcbiAgdGhpcy5fc3VtID0gdGhpcy5fcCA9IHRoaXMuX2kgPSB0aGlzLl9kID0gdGhpcy5femVybztcbiAgdGhpcy5fdGFyZ2V0ID0gdmFsO1xuICByZXR1cm4gdGhpcy5fdGFyZ2V0O1xufTtcblxuUElELnByb3RvdHlwZS51cGRhdGUgPSBmdW5jdGlvbih2YWwpIHtcbiAgdmFyIG5vdyA9IERhdGUubm93KCk7XG4gIHZhciBkdCA9IDA7XG4gIGlmICh0aGlzLl9sYXN0VGltZSAhPT0gbnVsbCkge1xuICAgIGR0ID0gKG5vdyAtIHRoaXMuX2xhc3RUaW1lKSAvIDEwMDA7XG4gIH1cbiAgdGhpcy5fbGFzdFRpbWUgPSBub3c7XG5cbiAgdmFyIGVyciA9IHRoaXMuX3RhcmdldCAtIHZhbDtcbiAgdmFyIGRFcnIgPSAoZXJyIC0gdGhpcy5fbGFzdEVycikqZHQ7XG4gIHRoaXMuX3N1bUVyciArPSBlcnIgKiBkdDtcbiAgdGhpcy5fbGFzdEVyciA9IGVycjtcblxuICB0aGlzLl9wID0gdGhpcy5fcEdhaW4qZXJyO1xuICB0aGlzLl9pID0gdGhpcy5faUdhaW4qdGhpcy5fc3VtRXJyO1xuICB0aGlzLl9kID0gdGhpcy5fZEdhaW4qZEVycjtcbiAgdGhpcy5fc3VtID0gdGhpcy5fcCt0aGlzLl9pK3RoaXMuX2Q7XG4gIGlmICh0aGlzLl9zdW0gPCB0aGlzLl9taW4pIHtcbiAgICB0aGlzLl9zdW0gPSB0aGlzLl9taW47XG4gIH0gZWxzZSBpZiAodGhpcy5fc3VtID4gdGhpcy5fbWF4KSB7XG4gICAgdGhpcy5fc3VtID0gdGhpcy5fbWF4O1xuICB9XG59O1xuXG5QSUQucHJvdG90eXBlLnBpZCA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4ge3A6IHRoaXMuX3AsIGk6IHRoaXMuX2ksIGQ6IHRoaXMuX2QsIHN1bTogdGhpcy5fc3VtfTtcbn07XG4iLCIvKiBnbG9iYWwgd2luZG93LCBXZWJTb2NrZXQgKi8gXG5cInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID0gV3NDbGllbnQ7XG5mdW5jdGlvbiBXc0NsaWVudCgpIHtcbiAgdGhpcy5fY29ubiA9IG51bGw7XG4gIHRoaXMuX2Nvbm5lY3RlZCA9IGZhbHNlO1xuICB0aGlzLl9xdWV1ZSA9IFtdO1xuICB0aGlzLl9saXN0ZW5lcnMgPSB7fTtcbiAgdGhpcy5fdGFrZW9mZkNicyA9IFtdO1xuICB0aGlzLl9sYW5kQ2JzID0gW107XG4gIHRoaXMuX2Nvbm5lY3QoKTtcbn1cblxuV3NDbGllbnQucHJvdG90eXBlLl9jb25uZWN0ID0gZnVuY3Rpb24oKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgc2VsZi5fY29ubiA9IG5ldyBXZWJTb2NrZXQoJ3dzOi8vJyt3aW5kb3cubG9jYXRpb24uaG9zdCk7XG4gIHNlbGYuX2Nvbm4ub25vcGVuID0gZnVuY3Rpb24oKSB7XG4gICAgc2VsZi5fY29ubmVjdGVkID0gdHJ1ZTtcbiAgICBzZWxmLl9xdWV1ZS5mb3JFYWNoKGZ1bmN0aW9uKG1zZykge1xuICAgICAgc2VsZi5fY29ubi5zZW5kKG1zZyk7XG4gICAgfSk7XG4gICAgc2VsZi5fcXVldWUgPSBbXTtcblxuICAgIHNlbGYuX2Nvbm4ub25tZXNzYWdlID0gZnVuY3Rpb24obXNnKSB7XG4gICAgICB0cnkge1xuICAgICAgICBtc2cgPSBKU09OLnBhcnNlKG1zZy5kYXRhKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHZhciBraW5kID0gbXNnLnNoaWZ0KCk7XG4gICAgICBzd2l0Y2ggKGtpbmQpIHtcbiAgICAgICAgY2FzZSAndGFrZW9mZic6XG4gICAgICAgICAgc2VsZi5fdGFrZW9mZkNicy5mb3JFYWNoKGZ1bmN0aW9uKGNiKSB7XG4gICAgICAgICAgICBjYigpO1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIHNlbGYuX3Rha2VvZmZDYnMgPSBbXTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnbGFuZCc6XG4gICAgICAgICAgc2VsZi5fbGFuZENicy5mb3JFYWNoKGZ1bmN0aW9uKGNiKSB7XG4gICAgICAgICAgICBjYigpO1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIHNlbGYuX2xhbmRDYnMgPSBbXTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnb24nOlxuICAgICAgICAgIHZhciBldmVudCA9IG1zZy5zaGlmdCgpO1xuICAgICAgICAgIHNlbGYuX2xpc3RlbmVyc1tldmVudF0uZm9yRWFjaChmdW5jdGlvbihjYikge1xuICAgICAgICAgICAgY2IuYXBwbHkoc2VsZiwgbXNnKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICBjb25zb2xlLmVycm9yKCd1bmtub3duIG1lc3NhZ2U6ICcra2luZCk7XG4gICAgICB9XG4gICAgfTtcbiAgfTtcblxufTtcblxuV3NDbGllbnQucHJvdG90eXBlLl9zZW5kID0gZnVuY3Rpb24obXNnKSB7XG4gIG1zZyA9IEpTT04uc3RyaW5naWZ5KG1zZyk7XG4gIGlmICghdGhpcy5fY29ubmVjdGVkKSB7XG4gICAgdGhpcy5fcXVldWUucHVzaChtc2cpO1xuICAgIHJldHVybjtcbiAgfVxuICB0aGlzLl9jb25uLnNlbmQobXNnKTtcbn07XG5cbldzQ2xpZW50LnByb3RvdHlwZS5vbiA9IGZ1bmN0aW9uKGV2ZW50LCBjYikge1xuICB2YXIgY2JzID0gdGhpcy5fbGlzdGVuZXJzW2V2ZW50XSA9IHRoaXMuX2xpc3RlbmVyc1tldmVudF0gfHwgW107XG4gIGNicy5wdXNoKGNiKTtcbiAgaWYgKGNicy5sZW5ndGggPT09IDEpIHtcbiAgICB0aGlzLl9zZW5kKFsnb24nLCBldmVudF0pO1xuICB9XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUudGFrZW9mZiA9IGZ1bmN0aW9uKGNiKSB7XG4gIHRoaXMuX3NlbmQoWyd0YWtlb2ZmJ10pO1xuICBpZiAoY2IpIHtcbiAgICB0aGlzLl90YWtlb2ZmQ2JzLnB1c2goY2IpO1xuICB9XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUubGFuZCA9IGZ1bmN0aW9uKGNiKSB7XG4gIHRoaXMuX3NlbmQoWydsYW5kJ10pO1xuICBpZiAoY2IpIHtcbiAgICB0aGlzLl9sYW5kQ2JzLnB1c2goY2IpO1xuICB9XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUucmlnaHQgPSBmdW5jdGlvbih2YWwpIHtcbiAgdGhpcy5fc2VuZChbJ3JpZ2h0JywgdmFsXSk7XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUuc3RvcCA9IGZ1bmN0aW9uKCkge1xuICB0aGlzLl9zZW5kKFsnc3RvcCddKTtcbn07XG4iXX0=
