# ardrone-football

Base project for the [JSConf.us 2014 NodeCopter Football challenge](http://nodecopter.com/football).

## Install

```bash
$ git clone https://github.com/nodecopter/ardrone-football.git
$ cd ardrone-football
$ npm install
```

Additionally you will need to install
[justrun](https://github.com/jmhodges/justrun) (binary downloads available) for
getting the frontend code to automatically rebuild on changes.

## Running

```bash
$ make
```

Then open your browser at [http://localhost:3000/](http://localhost:3000/).

## Details

The ardrone-football project provides you with a base project for experimenting
with in-browser computer vision for performing "penalty kicks" with an
ar-drone.

The project uses [dronestream](https://github.com/bkw/node-dronestream) to render
the video stream received from the drone, and allows you to select a color to
detect the ball. The detection algorithm is computing a very naive average
of the color distribution, and you should try to improve it or replace it with
[something better](http://inspirit.github.io/jsfeat/)..

Additionally the project comes with a simple [PID
Controller](https://en.wikipedia.org/wiki/PID_controller) which is setup to
align the drone with the ball.

The project itself is in various states of incompletion, and probably also full
of bugs, so feel free to rip out, change, or improve anything you want.
