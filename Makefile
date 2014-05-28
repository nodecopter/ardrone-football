JSHINT:="./node_modules/jshint/bin/jshint"
BROWSERIFY:="./node_modules/browserify/bin/cmd.js"
ALL_JSFILES:=$(shell find . -name '*.js' '!' -path './node_modules/*' '!' -path './frontend/build/*')
WATCH_FILES:=$(ALL_JSFILES) .jshintrc Makefile frontend/index.html frontend/css/main.css
FRONTEND_JSFILES:=$(shell find frontend/js -name '*.js')

dev:
	@justrun -c 'clear; make jshint frontend && ./backend/server.js' $(WATCH_FILES)

frontend: frontend/build/app.js frontend/build/index.html frontend/build/styles.css

frontend/build:
	mkdir -p frontend/build

frontend/build/app.js: $(FRONTEND_JSFILES) frontend/build
	$(BROWSERIFY) frontend/js/main.js -o $@ --debug

frontend/build/index.html: frontend/index.html frontend/build
	cp $< $@

frontend/build/styles.css: frontend/css/main.css frontend/build
	cp $< $@

jshint:
	$(JSHINT) $(ALL_JSFILES)

clean:
	rm -rf frontend/build

.PHONY: dev frontend jshint clean
